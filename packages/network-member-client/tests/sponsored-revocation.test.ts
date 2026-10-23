import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import {
    ContractFunctionRevertedError,
    decodeFunctionData,
    encodeErrorResult,
    type Account,
    type Address,
    type Chain,
    type Hex,
    type PublicClient,
    type Transport,
    type WalletClient
} from "viem"
import { getUserOperationHash } from "viem/account-abstraction"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import { RevocationRevertError } from "../src/errors"
import { SponsoredRelay } from "../src/sponsored-relay"
import {
    CREDENTIAL_REVOCATION_REGISTRY_ABI,
    DirectRevocationWriter,
    SponsoredRevocationWriter
} from "../src/sponsored-revocation"
import type { SponsoredUserOperation, UserOperationReceipt, UserOperationSubmitter } from "../src/user-operation"
import { createDeliverToStealthFixture } from "./fixtures"

jest.setTimeout(60_000)

const REGISTRY: RegistryLocation = { chainId: 31337n, address: `0x${"11".repeat(20)}` as Address }
const ENTRY_POINT = `0x${"44".repeat(20)}` as Address
const PAYMASTER = `0x${"55".repeat(20)}` as Address
const ACCOUNT_IMPLEMENTATION = `0x${"66".repeat(20)}` as Address
const CHAIN_ID = 31337
const COMMITMENT = 4242n
const LOW_LEAF_INDEX = 3n
const PROOF: NetworkMemberProof = {
    merkleTreeDepth: 1n,
    merkleTreeRoot: 2n,
    nullifier: 3n,
    scope: 4n,
    points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]
}

/** Mirrors `sponsored-relay.ts`'s own private ABI: not exported, so unwrapping the relayed call needs its own copy. */
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

const fixture = createDeliverToStealthFixture()
const paymasterIdentity = new Identity("sponsored-revocation-test-paymaster-member")
const paymasterGroup = new Group([paymasterIdentity.commitment])

function fakePublicClient(): Pick<
    PublicClient,
    "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract"
> {
    return {
        estimateFeesPerGas: jest.fn(async () => ({
            maxFeePerGas: 3_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n
        })),
        getBalance: jest.fn(async () => 0n),
        getTransactionCount: jest.fn(async () => 2),
        readContract: jest.fn(async (call: { functionName: string }) =>
            call.functionName === "getDeposit" ? 1000n : 7n
        )
    } as unknown as Pick<PublicClient, "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract">
}

function fakeSubmitter(receipt: UserOperationReceipt): {
    submitter: UserOperationSubmitter
    sent: SponsoredUserOperation[]
} {
    const sent: SponsoredUserOperation[] = []
    return {
        sent,
        submitter: {
            send: jest.fn<UserOperationSubmitter["send"]>(async (userOperation) => {
                sent.push(userOperation)
                return getUserOperationHash({
                    chainId: CHAIN_ID,
                    entryPointAddress: ENTRY_POINT,
                    entryPointVersion: "0.8",
                    userOperation
                })
            }),
            waitForReceipt: jest.fn<UserOperationSubmitter["waitForReceipt"]>(async () => receipt)
        }
    }
}

function buildSponsoredWriter(receipt: UserOperationReceipt): {
    writer: SponsoredRevocationWriter
    sent: SponsoredUserOperation[]
} {
    const { submitter, sent } = fakeSubmitter(receipt)
    const relay = new SponsoredRelay({
        chainId: CHAIN_ID,
        entryPoint: ENTRY_POINT,
        paymaster: PAYMASTER,
        accountImplementation: ACCOUNT_IMPLEMENTATION,
        memberKeys: {
            metaStealthAddress: fixture.metaStealthAddress,
            spendingPrivateKey: fixture.spending.privateKey,
            viewingPrivateKey: fixture.viewing.privateKey
        },
        paymasterIdentity,
        paymasterGroup: { currentGroup: async () => paymasterGroup },
        submitter,
        publicClient: fakePublicClient()
    })
    return { writer: new SponsoredRevocationWriter(REGISTRY, relay), sent }
}

describe("SponsoredRevocationWriter", () => {
    it("relays revoke(commitment, lowLeafIndex, proof) to the registry and reports the sponsorship", async () => {
        const { writer, sent } = buildSponsoredWriter({
            transactionHash: "0xbundletxhash" as Hex,
            success: true,
            actualGasCost: 555n,
            actualGasUsed: 111n
        })

        const write = await writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)

        expect(write.txHash).toBe("0xbundletxhash")
        expect(write.sponsorship?.paymaster).toBe(PAYMASTER)
        expect(sent).toHaveLength(1)
        // The relay wraps the call in Simple7702Account.execute, so the registry only sees what
        // that carries.
        const [target, value, inner] = decodeFunctionData({
            abi: SIMPLE_7702_ACCOUNT_ABI,
            data: sent[0].callData
        }).args
        expect(target).toBe(REGISTRY.address)
        expect(value).toBe(0n)
        const decoded = decodeFunctionData({ abi: CREDENTIAL_REVOCATION_REGISTRY_ABI, data: inner })
        expect(decoded.functionName).toBe("revoke")
        expect(decoded.args).toEqual([COMMITMENT, LOW_LEAF_INDEX, PROOF])
    })

    it("surfaces a stale low-leaf index as RevocationRevertError('InvalidLowLeaf'), which a caller retries", async () => {
        const { writer } = buildSponsoredWriter({
            transactionHash: "0xreverted" as Hex,
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason: encodeErrorResult({
                abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
                errorName: "InvalidLowLeaf"
            })
        })

        const revoking = writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)

        await expect(revoking).rejects.toBeInstanceOf(RevocationRevertError)
        await expect(revoking).rejects.toMatchObject({ reason: "InvalidLowLeaf" })
    })

    it("surfaces an already-revoked commitment as RevocationRevertError('LeafAlreadyExists'), which a caller does not", async () => {
        const { writer } = buildSponsoredWriter({
            transactionHash: "0xreverted" as Hex,
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason: encodeErrorResult({
                abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
                errorName: "LeafAlreadyExists"
            })
        })

        await expect(writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)).rejects.toMatchObject({
            reason: "LeafAlreadyExists"
        })
    })

    it("carries undecodable revert data through as the reason rather than losing it", async () => {
        const { writer } = buildSponsoredWriter({
            transactionHash: "0xreverted" as Hex,
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason: "0xdeadbeef"
        })

        await expect(writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)).rejects.toMatchObject({ reason: "0xdeadbeef" })
    })

    it("still reports a failure with no revert data at all", async () => {
        const { writer } = buildSponsoredWriter({
            transactionHash: "0xreverted" as Hex,
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n
        })

        await expect(writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)).rejects.toBeInstanceOf(RevocationRevertError)
    })
})

interface ContractCall {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
}

function walletClient(writeContract: (call: ContractCall) => Promise<Hex>) {
    return { writeContract } as unknown as Pick<WalletClient<Transport, Chain, Account>, "writeContract">
}

describe("DirectRevocationWriter", () => {
    it("writes revoke with the commitment, index and proof it is given", async () => {
        const writeContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => "0xtxhash")
        const writer = new DirectRevocationWriter(REGISTRY, walletClient(writeContract))

        const write = await writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)

        expect(write.txHash).toBe("0xtxhash")
        expect(write.sponsorship).toBeUndefined()
        expect(writeContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: REGISTRY.address,
                functionName: "revoke",
                args: [COMMITMENT, LOW_LEAF_INDEX, PROOF]
            })
        )
    })

    it("surfaces a named revert as RevocationRevertError", async () => {
        const writer = new DirectRevocationWriter(
            REGISTRY,
            walletClient(async () => {
                throw new ContractFunctionRevertedError({
                    abi: [...CREDENTIAL_REVOCATION_REGISTRY_ABI],
                    data: encodeErrorResult({ abi: CREDENTIAL_REVOCATION_REGISTRY_ABI, errorName: "InvalidLowLeaf" }),
                    functionName: "revoke"
                })
            })
        )

        await expect(writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)).rejects.toMatchObject({
            reason: "InvalidLowLeaf"
        })
    })

    it("lets a non-revert failure through untouched, so a transport error isn't read as a rejected revocation", async () => {
        const transportError = new Error("rpc unreachable")
        const writer = new DirectRevocationWriter(
            REGISTRY,
            walletClient(async () => {
                throw transportError
            })
        )

        await expect(writer.revoke(COMMITMENT, LOW_LEAF_INDEX, PROOF)).rejects.toBe(transportError)
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
