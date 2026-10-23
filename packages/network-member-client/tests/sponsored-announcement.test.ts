import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import { decodeFunctionData, type Address, type Hex, type PublicClient } from "viem"
import { getUserOperationHash } from "viem/account-abstraction"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import { ERC5564_ANNOUNCER_ABI } from "../src/adapters"
import { SponsoredAnnouncementSubmitter } from "../src/sponsored-announcement"
import { SponsoredRelay } from "../src/sponsored-relay"
import type { Announcement } from "../src/types"
import type { SponsoredUserOperation, UserOperationReceipt, UserOperationSubmitter } from "../src/user-operation"
import { createDeliverToStealthFixture } from "./fixtures"

jest.setTimeout(60_000)

const ANNOUNCER = `0x${"11".repeat(20)}` as Address
const ENTRY_POINT = `0x${"44".repeat(20)}` as Address
const PAYMASTER = `0x${"55".repeat(20)}` as Address
const ACCOUNT_IMPLEMENTATION = `0x${"66".repeat(20)}` as Address
const CHAIN_ID = 31337
const ANNOUNCEMENT: Announcement = {
    schemeId: 1,
    stealthAddress: `0x${"77".repeat(20)}` as Address,
    ephemeralPublicKey: `0x02${"88".repeat(32)}` as Hex,
    metadata: "0xab12cd" as Hex
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
const paymasterIdentity = new Identity("sponsored-announcement-test-paymaster-member")
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

function buildSubmitter(
    receipt: UserOperationReceipt,
    overrides: Partial<UserOperationSubmitter> = {}
): {
    announcer: SponsoredAnnouncementSubmitter
    sent: SponsoredUserOperation[]
} {
    const { submitter: base, sent } = fakeSubmitter(receipt)
    const submitter: UserOperationSubmitter = { ...base, ...overrides }
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
    return { announcer: new SponsoredAnnouncementSubmitter(ANNOUNCER, relay), sent }
}

describe("SponsoredAnnouncementSubmitter", () => {
    it("relays announce(...) to the announcer with no value and returns the bundle transaction hash", async () => {
        const { announcer, sent } = buildSubmitter({
            transactionHash: "0xbundletxhash" as Hex,
            success: true,
            actualGasCost: 555n,
            actualGasUsed: 111n
        })

        const txHash = await announcer.announce(ANNOUNCEMENT)

        expect(txHash).toBe("0xbundletxhash")
        expect(sent).toHaveLength(1)
        const [target, value, inner] = decodeFunctionData({
            abi: SIMPLE_7702_ACCOUNT_ABI,
            data: sent[0].callData
        }).args
        expect(target).toBe(ANNOUNCER)
        expect(value).toBe(0n)
        const decoded = decodeFunctionData({ abi: ERC5564_ANNOUNCER_ABI, data: inner })
        expect(decoded.functionName).toBe("announce")
        expect(decoded.args).toEqual([
            BigInt(ANNOUNCEMENT.schemeId),
            ANNOUNCEMENT.stealthAddress,
            ANNOUNCEMENT.ephemeralPublicKey,
            ANNOUNCEMENT.metadata
        ])
    })

    it("throws with the revert data as the cause when the operation reverts", async () => {
        const { announcer } = buildSubmitter({
            transactionHash: "0xreverted" as Hex,
            success: false,
            actualGasCost: 10n,
            actualGasUsed: 5n,
            revertReason: "0xdeadbeef"
        })

        const announcing = announcer.announce(ANNOUNCEMENT)

        await expect(announcing).rejects.toBeInstanceOf(Error)
        await expect(announcing).rejects.toMatchObject({ cause: "0xdeadbeef" })
    })

    it("propagates a bundler failure instead of returning a hash", async () => {
        const { announcer } = buildSubmitter(
            { transactionHash: "0xunused" as Hex, success: true, actualGasCost: 1n, actualGasUsed: 1n },
            { send: jest.fn<UserOperationSubmitter["send"]>(async () => Promise.reject(new Error("bundler down"))) }
        )

        await expect(announcer.announce(ANNOUNCEMENT)).rejects.toThrow("bundler down")
    })

    it("propagates a receipt wait failure", async () => {
        const { announcer, sent } = buildSubmitter(
            { transactionHash: "0xunused" as Hex, success: true, actualGasCost: 1n, actualGasUsed: 1n },
            {
                waitForReceipt: jest.fn<UserOperationSubmitter["waitForReceipt"]>(async () =>
                    Promise.reject(new Error("receipt timed out"))
                )
            }
        )

        await expect(announcer.announce(ANNOUNCEMENT)).rejects.toThrow("receipt timed out")
        expect(sent).toHaveLength(1)
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
