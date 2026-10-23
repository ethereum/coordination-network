import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeErrorResult,
    getAddress,
    recoverAddress,
    size,
    type Address,
    type Hex,
    type PublicClient
} from "viem"
import { getUserOperationHash } from "viem/account-abstraction"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import type { Hex32 } from "@coordination-network/credential"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import { IDENTITY_REGISTRY_ABI } from "../src/adapters"
import { RegistryRevertError } from "../src/errors"
import { SponsoredIdentityRegistryWriter } from "../src/sponsored"
import type { SponsoredMemberKeys } from "../src/sponsored"
import type { GroupMirror } from "../src/types"
import type { SponsoredUserOperation, UserOperationReceipt, UserOperationSubmitter } from "../src/user-operation"
import { createDeliverToStealthFixture } from "./fixtures"

jest.setTimeout(60_000)

const REGISTRY: RegistryLocation = { chainId: 31337n, address: `0x${"11".repeat(20)}` as Address }
const ENTRY_POINT = `0x${"44".repeat(20)}` as Address
const PAYMASTER = `0x${"55".repeat(20)}` as Address
const ACCOUNT_IMPLEMENTATION = `0x${"66".repeat(20)}` as Address
const CHAIN_ID = 31337
const NETWORK_ID = `0x${"aa".repeat(32)}` as Hex32
const META_STEALTH_ADDRESS = `0x${"bb".repeat(66)}` as Hex
const PROOF: NetworkMemberProof = {
    merkleTreeDepth: 1n,
    merkleTreeRoot: 2n,
    nullifier: 3n,
    scope: 4n,
    points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]
}

/** Mirrors `sponsored.ts`'s own private ABI: not exported, so a decode assertion needs its own copy. */
const SIMPLE_7702_ACCOUNT_ABI = [
    {
        type: "function",
        name: "execute",
        stateMutability: "nonpayable",
        inputs: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" }
        ],
        outputs: []
    }
] as const

const PAYMASTER_PROOF_ABI_PARAMS = [
    { name: "merkleTreeDepth", type: "uint256" },
    { name: "merkleTreeRoot", type: "uint256" },
    { name: "nullifier", type: "uint256" },
    { name: "message", type: "uint256" },
    { name: "scope", type: "uint256" },
    { name: "points", type: "uint256[8]" }
] as const

const fixture = createDeliverToStealthFixture()
const memberKeys: SponsoredMemberKeys = {
    metaStealthAddress: fixture.metaStealthAddress,
    spendingPrivateKey: fixture.spending.privateKey,
    viewingPrivateKey: fixture.viewing.privateKey
}

const paymasterIdentity = new Identity("sponsored-writer-test-paymaster-member")
const paymasterGroupValue = new Group([paymasterIdentity.commitment])
const paymasterGroup: GroupMirror = { currentGroup: async () => paymasterGroupValue }

interface ReadContractCall {
    address: Address
    functionName: string
    args?: readonly unknown[]
}

/** getBalance/getDeposit each read twice (before, after); getNonce/getTransactionCount once. */
function fakePublicClient(options: {
    balances?: [bigint, bigint]
    deposits?: [bigint, bigint]
    nonce?: bigint
    transactionCount?: number
}): Pick<PublicClient, "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract"> {
    const balances = [...(options.balances ?? [0n, 0n])]
    const deposits = [...(options.deposits ?? [1000n, 877n])]
    return {
        estimateFeesPerGas: jest.fn(async () => ({
            maxFeePerGas: 3_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n
        })),
        getBalance: jest.fn(async () => balances.shift() as bigint),
        getTransactionCount: jest.fn(async () => options.transactionCount ?? 2),
        readContract: jest.fn(async (call: ReadContractCall) => {
            if (call.functionName === "getDeposit") return deposits.shift() as bigint
            if (call.functionName === "getNonce") return options.nonce ?? 7n
            throw new Error(`unexpected readContract call ${call.functionName}`)
        })
    } as unknown as Pick<PublicClient, "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract">
}

/** `returnedHash` defaults to the userOperation's own hash, matching what a real bundler echoes
 *  back; pass a different one to test the mismatch check. */
function fakeSubmitter(
    receipt: UserOperationReceipt,
    options: { returnedHash?: Hex } = {}
): {
    submitter: UserOperationSubmitter
    sent: SponsoredUserOperation[]
} {
    const sent: SponsoredUserOperation[] = []
    return {
        sent,
        submitter: {
            send: jest.fn<UserOperationSubmitter["send"]>(async (userOperation) => {
                sent.push(userOperation)
                return (
                    options.returnedHash ??
                    getUserOperationHash({
                        chainId: CHAIN_ID,
                        entryPointAddress: ENTRY_POINT,
                        entryPointVersion: "0.8",
                        userOperation
                    })
                )
            }),
            waitForReceipt: jest.fn<UserOperationSubmitter["waitForReceipt"]>(async () => receipt)
        }
    }
}

function buildWriter(
    overrides: {
        publicClient?: Pick<PublicClient, "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract">
        submitter?: UserOperationSubmitter
    } = {}
): SponsoredIdentityRegistryWriter {
    return new SponsoredIdentityRegistryWriter({
        registry: REGISTRY,
        chainId: CHAIN_ID,
        entryPoint: ENTRY_POINT,
        paymaster: PAYMASTER,
        accountImplementation: ACCOUNT_IMPLEMENTATION,
        memberKeys,
        paymasterIdentity,
        paymasterGroup,
        submitter:
            overrides.submitter ??
            fakeSubmitter({ transactionHash: "0xunused", success: true, actualGasCost: 0n, actualGasUsed: 0n })
                .submitter,
        publicClient: overrides.publicClient ?? fakePublicClient({})
    })
}

describe("SponsoredIdentityRegistryWriter", () => {
    it("submits a sponsored registerIdentity operation and reports the paymaster's sponsorship", async () => {
        const receipt: UserOperationReceipt = {
            transactionHash: "0xbundletxhash" as Hex,
            success: true,
            actualGasCost: 555n,
            actualGasUsed: 111n
        }
        const { submitter, sent } = fakeSubmitter(receipt)
        const publicClient = fakePublicClient({
            balances: [0n, 0n],
            deposits: [1000n, 877n],
            nonce: 7n,
            transactionCount: 2
        })
        const writer = buildWriter({ submitter, publicClient })

        const write = await writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        expect(write.txHash).toBe("0xbundletxhash")
        expect(write.sponsorship).toBeDefined()
        const sponsorship = write.sponsorship
        if (!sponsorship) throw new Error("expected sponsorship")
        expect(sponsorship.senderBalanceBefore).toBe(0n)
        expect(sponsorship.senderBalanceAfter).toBe(0n)
        expect(sponsorship.paymasterDepositBefore).toBe(1000n)
        expect(sponsorship.paymasterDepositAfter).toBe(877n)
        expect(sponsorship.actualGasCost).toBe(555n)
        expect(sponsorship.bundleTxHash).toBe("0xbundletxhash")
        expect(sponsorship.paymaster).toBe(PAYMASTER)

        expect(sent).toHaveLength(1)
        const op = sent[0]
        expect(op.sender).toBe(sponsorship.sender)
        expect(op.nonce).toBe(7n)
        expect(op.factory).toBe("0x7702")
        expect(op.paymaster).toBe(PAYMASTER)
        expect(op.authorization).toMatchObject({
            address: ACCOUNT_IMPLEMENTATION,
            chainId: CHAIN_ID,
            nonce: 2
        })

        // The callData is Simple7702Account.execute(registry, 0, registerIdentity(...)).
        const decodedExecute = decodeFunctionData({ abi: SIMPLE_7702_ACCOUNT_ABI, data: op.callData })
        expect(decodedExecute.functionName).toBe("execute")
        const [target, value, innerData] = decodedExecute.args
        expect(target).toBe(REGISTRY.address)
        expect(value).toBe(0n)
        const decodedRegisterIdentity = decodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, data: innerData })
        expect(decodedRegisterIdentity.functionName).toBe("registerIdentity")
        expect(decodedRegisterIdentity.args).toEqual([NETWORK_ID, META_STEALTH_ADDRESS, PROOF])

        // Proof encoding: 13 words (5 scalars + 8 points), message = scope = the disposable
        // sender, root = the mirrored paymaster group's own root.
        expect(size(op.paymasterData)).toBe(13 * 32)
        const decodedProof = decodeAbiParameters(PAYMASTER_PROOF_ABI_PARAMS, op.paymasterData)
        const [, merkleTreeRoot, , message, scope] = decodedProof
        expect(message).toBe(BigInt(sponsorship.sender))
        expect(scope).toBe(BigInt(sponsorship.sender))
        expect(merkleTreeRoot).toBe(BigInt(paymasterGroupValue.root))

        // factory: "0x7702" packs to an initCode built from the authorization's delegate, not
        // the literal marker string, so the hash actually depends on which contract is delegated.
        const hash = getUserOperationHash({
            chainId: CHAIN_ID,
            entryPointAddress: ENTRY_POINT,
            entryPointVersion: "0.8",
            userOperation: op
        })
        expect(sponsorship.userOpHash).toBe(hash)
        const hashWithoutDelegation = getUserOperationHash({
            chainId: CHAIN_ID,
            entryPointAddress: ENTRY_POINT,
            entryPointVersion: "0.8",
            userOperation: { ...op, authorization: undefined }
        })
        expect(hashWithoutDelegation).not.toBe(hash)

        // The signature recovers to the disposable sender against that same hash.
        const recovered = await recoverAddress({ hash, signature: op.signature })
        expect(getAddress(recovered)).toBe(getAddress(sponsorship.sender))
    })

    it("throws RegistryRevertError('AlreadyRegistered') when the revert reason decodes to it", async () => {
        const revertReason = encodeErrorResult({
            abi: IDENTITY_REGISTRY_ABI,
            errorName: "AlreadyRegistered",
            args: [NETWORK_ID]
        })
        const { submitter } = fakeSubmitter({
            transactionHash: "0xreverted",
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason
        })
        const writer = buildWriter({ submitter })

        const registration = writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        await expect(registration).rejects.toBeInstanceOf(RegistryRevertError)
        await expect(registration).rejects.toMatchObject({ errorName: "AlreadyRegistered" })
    })

    it("throws a plain error when the revert reason decodes to a different registry error", async () => {
        const revertReason = encodeErrorResult({
            abi: IDENTITY_REGISTRY_ABI,
            errorName: "NotRegistered",
            args: [NETWORK_ID]
        })
        const { submitter } = fakeSubmitter({
            transactionHash: "0xreverted",
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason
        })
        const writer = buildWriter({ submitter })

        const registration = writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        await expect(registration).rejects.not.toBeInstanceOf(RegistryRevertError)
        await expect(registration).rejects.toMatchObject({ message: expect.not.stringContaining(NETWORK_ID) })
    })

    it("throws a plain error when the revert reason is not decodable at all", async () => {
        const { submitter } = fakeSubmitter({
            transactionHash: "0xreverted",
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason: "0xdeadbeef"
        })
        const writer = buildWriter({ submitter })

        const registration = writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        await expect(registration).rejects.not.toBeInstanceOf(RegistryRevertError)
        await expect(registration).rejects.toMatchObject({ message: expect.not.stringContaining(NETWORK_ID) })
    })

    it("throws a plain error on failure with no revert reason at all", async () => {
        const { submitter } = fakeSubmitter({
            transactionHash: "0xreverted",
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n
        })
        const writer = buildWriter({ submitter })

        const registration = writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        await expect(registration).rejects.not.toBeInstanceOf(RegistryRevertError)
        await expect(registration).rejects.toMatchObject({ message: expect.not.stringContaining(NETWORK_ID) })
    })

    it("throws immediately when the bundler's returned hash doesn't match the locally computed one, instead of waiting on a receipt for a different operation", async () => {
        const { submitter } = fakeSubmitter(
            { transactionHash: "0xunused", success: true, actualGasCost: 0n, actualGasUsed: 0n },
            { returnedHash: `0x${"99".repeat(32)}` as Hex }
        )
        const writer = buildWriter({ submitter })

        const registration = writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        await expect(registration).rejects.toThrow(/userOpHash/)
        expect(submitter.waitForReceipt).not.toHaveBeenCalled()
    })

    it("derives a different disposable sender for a second registerIdentity call, so the two cannot be linked", async () => {
        const { submitter, sent } = fakeSubmitter({
            transactionHash: "0xbundletxhash" as Hex,
            success: true,
            actualGasCost: 1n,
            actualGasUsed: 1n
        })
        const firstWriter = buildWriter({ submitter, publicClient: fakePublicClient({}) })
        const secondWriter = buildWriter({ submitter, publicClient: fakePublicClient({}) })

        await firstWriter.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)
        await secondWriter.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        expect(sent).toHaveLength(2)
        expect(sent[0].sender).not.toBe(sent[1].sender)
    })
})

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

beforeAll(async () => {
    curve = await getCurveFromName("bn128")
})

afterAll(async () => {
    await curve.terminate()
})
