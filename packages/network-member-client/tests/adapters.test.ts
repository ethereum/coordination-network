import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import {
    BaseError,
    ContractFunctionRevertedError,
    decodeFunctionData,
    encodeErrorResult,
    encodeFunctionData,
    slice,
    toFunctionSelector,
    type Account,
    type Address,
    type Chain,
    type Hex,
    type Log,
    type PublicClient,
    type Transport,
    type WalletClient
} from "viem"
import type { Hex32 } from "@coordination-network/credential"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import { RevocationAction, UpdateAction } from "@coordination-network/network-member-proof"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import {
    ApprovedIssuerSetClient,
    ERC5564AnnouncerClient,
    IdentityRegistryClient,
    IdentityRegistryWriter,
    SemaphoreGroupClient,
    SemaphoreRegistrationProver,
    SemaphoreRevocationProver
} from "../src/adapters"
import { RegistryRevertError } from "../src/errors"
import type { Announcement, GroupMirror } from "../src/types"

const REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111" as Address
const SET_ADDRESS = "0x2222222222222222222222222222222222222222" as Address
const ANNOUNCER_ADDRESS = "0x3333333333333333333333333333333333333333" as Address
const SEMAPHORE_ADDRESS = "0x5555555555555555555555555555555555555555" as Address
const GROUP_ID = 7n
const NETWORK_ID = `0x${"aa".repeat(32)}` as Hex32
const META_STEALTH_ADDRESS = `0x${"bb".repeat(66)}` as Hex
const REGISTRY: RegistryLocation = { chainId: 31337n, address: REGISTRY_ADDRESS }

const ANNOUNCEMENT: Announcement = {
    schemeId: 1,
    stealthAddress: "0x4444444444444444444444444444444444444444" as Address,
    ephemeralPublicKey: `0x${"cc".repeat(33)}` as Hex,
    metadata: "0x05" as Hex
}

/** What this suite asserts on out of a `readContract`/`writeContract` call, narrower than viem's own generic overload so jest.fn() can implement it. */
interface ContractCall {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
    blockNumber?: bigint
}

function publicClient(readContract: (call: ContractCall) => Promise<unknown>, getBlockNumber?: () => Promise<bigint>) {
    return { readContract, getBlockNumber } as unknown as Pick<PublicClient, "readContract" | "getBlockNumber">
}

function walletClient(writeContract: (call: ContractCall) => Promise<Hex>) {
    return { writeContract } as unknown as Pick<WalletClient<Transport, Chain, Account>, "writeContract">
}

describe("IdentityRegistryClient", () => {
    it("reads IdentityRegistry.identity with the right selector and args", async () => {
        const readContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => META_STEALTH_ADDRESS)
        const reader = new IdentityRegistryClient(REGISTRY_ADDRESS, publicClient(readContract))

        const result = await reader.getIdentity(NETWORK_ID)

        expect(result).toBe(META_STEALTH_ADDRESS)
        const [call] = readContract.mock.calls[0]
        expect(call.address).toBe(REGISTRY_ADDRESS)
        expect(call.functionName).toBe("identity")
        expect(call.args).toEqual([NETWORK_ID])

        const calldata = encodeFunctionData({ abi: call.abi, functionName: "identity", args: [NETWORK_ID] })
        expect(slice(calldata, 0, 4)).toBe(
            toFunctionSelector("function identity(bytes32 networkId) view returns (bytes)")
        )
    })

    it("resolves empty bytes (unregistered) to null", async () => {
        const readContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => "0x")
        const reader = new IdentityRegistryClient(REGISTRY_ADDRESS, publicClient(readContract))

        expect(await reader.getIdentity(NETWORK_ID)).toBeNull()
    })
})

describe("ApprovedIssuerSetClient", () => {
    it("reads getLeafCount pinned to the current block", async () => {
        const readContract = jest.fn<(call: ContractCall) => Promise<bigint>>(async () => 3n)
        const client = new ApprovedIssuerSetClient(
            SET_ADDRESS,
            publicClient(readContract, async () => 7n)
        )

        expect(await client.getLeafCount()).toBe(3n)
        const [call] = readContract.mock.calls[0]
        expect(call.functionName).toBe("getLeafCount")
        expect(call.blockNumber).toBe(7n)
    })

    it("pages getLeaves at the block pinned by getLeafCount and decodes the returned leaves", async () => {
        const results: Record<string, unknown> = { getLeafCount: 3n, getLeaves: [1n, 2n, 3n] }
        const readContract = jest.fn<(call: ContractCall) => Promise<unknown>>(
            async (call) => results[call.functionName]
        )
        const blocks = [7n, 8n]
        const getBlockNumber = jest.fn(async () => blocks.shift() as bigint)
        const client = new ApprovedIssuerSetClient(SET_ADDRESS, publicClient(readContract, getBlockNumber))

        await client.getLeafCount()
        const leaves = await client.getLeaves(0, 3)

        expect(leaves).toEqual([1n, 2n, 3n])
        expect(getBlockNumber).toHaveBeenCalledTimes(1)
        const [call] = readContract.mock.calls[1]
        expect(call.functionName).toBe("getLeaves")
        expect(call.args).toEqual([0n, 3n])
        expect(call.blockNumber).toBe(7n)

        const calldata = encodeFunctionData({ abi: call.abi, functionName: "getLeaves", args: [0n, 3n] })
        expect(slice(calldata, 0, 4)).toBe(
            toFunctionSelector("function getLeaves(uint256 start, uint256 end) view returns (uint256[] leaves)")
        )
    })
})

describe("ERC5564AnnouncerClient", () => {
    it("submits announce with the built announcement's fields and returns the tx hash", async () => {
        const writeContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => "0xtxhash")
        const submitter = new ERC5564AnnouncerClient(ANNOUNCER_ADDRESS, walletClient(writeContract))

        const txHash = await submitter.announce(ANNOUNCEMENT)

        expect(txHash).toBe("0xtxhash")
        const [call] = writeContract.mock.calls[0]
        expect(call.address).toBe(ANNOUNCER_ADDRESS)
        expect(call.functionName).toBe("announce")
        expect(call.args).toEqual([
            1n,
            ANNOUNCEMENT.stealthAddress,
            ANNOUNCEMENT.ephemeralPublicKey,
            ANNOUNCEMENT.metadata
        ])

        const calldata = encodeFunctionData({ abi: call.abi, functionName: "announce", args: call.args })
        expect(slice(calldata, 0, 4)).toBe(
            toFunctionSelector(
                "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"
            )
        )

        const decoded = decodeFunctionData({ abi: call.abi, data: calldata })
        expect(decoded.args).toEqual(call.args)
    })
})

const PROOF: NetworkMemberProof = {
    merkleTreeDepth: 1n,
    merkleTreeRoot: 2n,
    nullifier: 3n,
    scope: 4n,
    points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]
}

/** A revert as viem itself would decode it, for exercising the writer's error mapping without a chain. */
function revertedWriteError(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
    const abi = [
        { type: "error", name: errorName, inputs: args.map((_, i) => ({ name: `arg${i}`, type: "bytes32" })) }
    ] as const
    const data = encodeErrorResult({ abi, errorName, args })
    return new ContractFunctionRevertedError({ abi, data, functionName: "registerIdentity" })
}

describe("IdentityRegistryWriter", () => {
    it("submits registerIdentity with the right selector and args", async () => {
        const writeContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => "0xtxhash")
        const writer = new IdentityRegistryWriter(REGISTRY, walletClient(writeContract))

        const write = await writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        expect(write).toEqual({ txHash: "0xtxhash" })
        const [call] = writeContract.mock.calls[0]
        expect(call.address).toBe(REGISTRY_ADDRESS)
        expect(call.functionName).toBe("registerIdentity")
        expect(call.args).toEqual([NETWORK_ID, META_STEALTH_ADDRESS, PROOF])

        const calldata = encodeFunctionData({ abi: call.abi, functionName: "registerIdentity", args: call.args })
        expect(slice(calldata, 0, 4)).toBe(
            toFunctionSelector(
                "function registerIdentity(bytes32 networkId, bytes metaStealthAddress, (uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 scope, uint256[8] points) proof)"
            )
        )
    })

    it("maps a named revert to RegistryRevertError", async () => {
        const writeContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => {
            throw revertedWriteError("AlreadyRegistered", [NETWORK_ID])
        })
        const writer = new IdentityRegistryWriter(REGISTRY, walletClient(writeContract))

        const write = writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)

        await expect(write).rejects.toBeInstanceOf(RegistryRevertError)
        await expect(write).rejects.toMatchObject({ code: "REGISTRATION_REJECTED", errorName: "AlreadyRegistered" })
    })

    it("rethrows a non-revert failure unchanged", async () => {
        const transportError = new Error("connection reset")
        const writeContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => {
            throw transportError
        })
        const writer = new IdentityRegistryWriter(REGISTRY, walletClient(writeContract))

        await expect(writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)).rejects.toBe(transportError)
    })

    it("rethrows a viem error that wraps no contract revert unchanged", async () => {
        const viemError = new BaseError("rpc unavailable")
        const writeContract = jest.fn<(call: ContractCall) => Promise<Hex>>(async () => {
            throw viemError
        })
        const writer = new IdentityRegistryWriter(REGISTRY, walletClient(writeContract))

        await expect(writer.registerIdentity(NETWORK_ID, META_STEALTH_ADDRESS, PROOF)).rejects.toBe(viemError)
    })
})

/** Minimal shape of a decoded Semaphore group event, enough to drive the mirror's replay. */
interface GroupLog {
    eventName: "MemberAdded" | "MembersAdded" | "MemberUpdated" | "MemberRemoved"
    args: Record<string, unknown>
    blockNumber: bigint
    logIndex: number
}

interface LogsCall {
    address: Address
    event: { name: GroupLog["eventName"] }
    args?: Record<string, unknown>
    fromBlock?: bigint
    toBlock?: bigint
    strict?: boolean
}

function semaphoreGroupClient(
    logsByEvent: Partial<Record<GroupLog["eventName"], GroupLog[]>>,
    onChainRoot: bigint | (() => Promise<bigint>),
    blockNumber = 100n
) {
    const getLogs = jest.fn<(call: LogsCall) => Promise<Log[]>>(
        async (call) => (logsByEvent[call.event.name] ?? []) as unknown as Log[]
    )
    const readContract = jest.fn<() => Promise<bigint>>(
        typeof onChainRoot === "function" ? onChainRoot : async () => onChainRoot
    )
    const getBlockNumber = jest.fn<() => Promise<bigint>>(async () => blockNumber)
    const client = {
        getLogs,
        readContract,
        getBlockNumber
    } as unknown as Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">

    return { client, getLogs, readContract, getBlockNumber }
}

describe("SemaphoreGroupClient", () => {
    const C0 = 111n
    const C1 = 222n
    const C2 = 333n
    const C1_UPDATED = 444n

    it("replays add, batch-add, update and remove in emission order into a leaf array matching the chain's root, one topic-filtered query per event", async () => {
        const expected = new Group([C0, C1_UPDATED, 0n])
        const { client, getLogs } = semaphoreGroupClient(
            {
                MemberAdded: [
                    {
                        eventName: "MemberAdded",
                        args: { groupId: GROUP_ID, index: 0n, identityCommitment: C0 },
                        blockNumber: 1n,
                        logIndex: 0
                    }
                ],
                MembersAdded: [
                    {
                        eventName: "MembersAdded",
                        args: { groupId: GROUP_ID, startIndex: 1n, identityCommitments: [C1, C2] },
                        blockNumber: 2n,
                        logIndex: 0
                    }
                ],
                MemberUpdated: [
                    {
                        eventName: "MemberUpdated",
                        args: {
                            groupId: GROUP_ID,
                            index: 1n,
                            identityCommitment: C1,
                            newIdentityCommitment: C1_UPDATED
                        },
                        blockNumber: 3n,
                        logIndex: 0
                    }
                ],
                MemberRemoved: [
                    {
                        eventName: "MemberRemoved",
                        args: { groupId: GROUP_ID, index: 2n, identityCommitment: C2 },
                        blockNumber: 4n,
                        logIndex: 0
                    }
                ]
            },
            expected.root
        )
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        const group = await mirror.currentGroup()

        expect(group.root).toBe(expected.root)
        expect(group.indexOf(C0)).toBe(0)
        expect(group.indexOf(C1_UPDATED)).toBe(1)
        expect(group.indexOf(C2)).toBe(-1)

        expect(getLogs).toHaveBeenCalledTimes(4)
        for (const [call] of getLogs.mock.calls) {
            expect(call.address).toBe(SEMAPHORE_ADDRESS)
            expect(call.args).toEqual({ groupId: GROUP_ID })
            expect(call.strict).toBe(true)
        }
        expect(getLogs.mock.calls.map(([call]) => call.event.name)).toEqual([
            "MemberAdded",
            "MembersAdded",
            "MemberUpdated",
            "MemberRemoved"
        ])
    })

    it("orders same-block logs across per-event queries by logIndex, not query order", async () => {
        // MemberRemoved is queried last (SEMAPHORE_GROUP_EVENTS lists it fourth) but has the
        // earlier logIndex, so a correct merge must still apply it before MemberAdded.
        const { client } = semaphoreGroupClient(
            {
                MemberAdded: [
                    {
                        eventName: "MemberAdded",
                        args: { groupId: GROUP_ID, index: 0n, identityCommitment: C0 },
                        blockNumber: 5n,
                        logIndex: 1
                    }
                ],
                MemberRemoved: [
                    {
                        eventName: "MemberRemoved",
                        args: { groupId: GROUP_ID, index: 0n, identityCommitment: C0 },
                        blockNumber: 5n,
                        logIndex: 0
                    }
                ]
            },
            new Group([C0]).root
        )
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        const group = await mirror.currentGroup()

        expect(group.indexOf(C0)).toBe(0)
    })

    it("orders logs from different blocks by block number, whatever order the queries return them in", async () => {
        // MemberAdded (queried first) is the later block, so the merged list starts out reversed.
        const { client } = semaphoreGroupClient(
            {
                MemberAdded: [
                    {
                        eventName: "MemberAdded",
                        args: { groupId: GROUP_ID, index: 0n, identityCommitment: C0 },
                        blockNumber: 6n,
                        logIndex: 0
                    }
                ],
                MemberRemoved: [
                    {
                        eventName: "MemberRemoved",
                        args: { groupId: GROUP_ID, index: 0n, identityCommitment: C0 },
                        blockNumber: 5n,
                        logIndex: 0
                    }
                ]
            },
            new Group([C0]).root
        )
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        const group = await mirror.currentGroup()

        expect(group.indexOf(C0)).toBe(0)
    })

    it("throws GROUP_MIRROR_UNAVAILABLE when no membership events are found for the group", async () => {
        const { client } = semaphoreGroupClient({}, 0n)
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        await expect(mirror.currentGroup()).rejects.toMatchObject({
            code: "GROUP_MIRROR_UNAVAILABLE",
            message: expect.stringContaining(`no membership events for group ${GROUP_ID}`)
        })
    })

    it("throws GROUP_MIRROR_UNAVAILABLE naming the leaf indexes fromBlock skipped over", async () => {
        // Only index 2 is ever added: fromBlock skipped whatever admitted indexes 0 and 1.
        const { client } = semaphoreGroupClient(
            {
                MemberAdded: [
                    {
                        eventName: "MemberAdded",
                        args: { groupId: GROUP_ID, index: 2n, identityCommitment: C0 },
                        blockNumber: 1n,
                        logIndex: 0
                    }
                ]
            },
            0n
        )
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        await expect(mirror.currentGroup()).rejects.toMatchObject({
            code: "GROUP_MIRROR_UNAVAILABLE",
            message: expect.stringContaining("0, 1")
        })
    })

    it("caps the missing-index list at 10 and reports the total hole count", async () => {
        // Only index 20 is ever added: indexes 0-19 are all holes, more than the cap.
        const { client } = semaphoreGroupClient(
            {
                MemberAdded: [
                    {
                        eventName: "MemberAdded",
                        args: { groupId: GROUP_ID, index: 20n, identityCommitment: C0 },
                        blockNumber: 1n,
                        logIndex: 0
                    }
                ]
            },
            0n
        )
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        const rejection = mirror.currentGroup()
        await expect(rejection).rejects.toMatchObject({
            code: "GROUP_MIRROR_UNAVAILABLE",
            message: expect.stringContaining("20")
        })
        await expect(rejection).rejects.toMatchObject({
            message: expect.not.stringContaining("10, 11")
        })
    })

    it("throws GROUP_MIRROR_UNAVAILABLE when the rebuilt root does not match the chain's", async () => {
        const { client } = semaphoreGroupClient(
            {
                MemberAdded: [
                    {
                        eventName: "MemberAdded",
                        args: { groupId: GROUP_ID, index: 0n, identityCommitment: C0 },
                        blockNumber: 1n,
                        logIndex: 0
                    }
                ]
            },
            999n // wrong root
        )
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        await expect(mirror.currentGroup()).rejects.toMatchObject({ code: "GROUP_MIRROR_UNAVAILABLE" })
    })

    it("throws GROUP_MIRROR_UNAVAILABLE when the chain read fails", async () => {
        const { client } = semaphoreGroupClient({}, async () => {
            throw new Error("rpc down")
        })
        const mirror = new SemaphoreGroupClient(SEMAPHORE_ADDRESS, GROUP_ID, client)

        await expect(mirror.currentGroup()).rejects.toMatchObject({ code: "GROUP_MIRROR_UNAVAILABLE" })
    })
})

describe("SemaphoreRegistrationProver", () => {
    it("throws MEMBER_NOT_IN_GROUP without generating a proof when the identity is not a mirrored member", async () => {
        const identity = new Identity("not-a-member")
        const currentGroup = jest.fn(async () => new Group([1n, 2n, 3n]))
        const groupMirror: GroupMirror = { currentGroup }
        const prover = new SemaphoreRegistrationProver({
            identity,
            groupMirror,
            registry: { chainId: 1n, address: REGISTRY_ADDRESS }
        })

        const proving = prover.prove({
            action: UpdateAction.Register,
            networkId: NETWORK_ID,
            metaStealthAddress: META_STEALTH_ADDRESS
        })

        await expect(proving).rejects.toMatchObject({ code: "MEMBER_NOT_IN_GROUP" })
        expect(currentGroup).toHaveBeenCalledTimes(1)
    })

    it("proves against the group the mirror reports when the identity is a member", async () => {
        const identity = new Identity("a-registering-member")
        const group = new Group([identity.commitment, 2n])
        const prover = new SemaphoreRegistrationProver({
            identity,
            groupMirror: { currentGroup: async () => group },
            registry: REGISTRY
        })

        const proof = await prover.prove({
            action: UpdateAction.Register,
            networkId: NETWORK_ID,
            metaStealthAddress: META_STEALTH_ADDRESS
        })

        expect(proof.merkleTreeRoot).toBe(BigInt(group.root))
    }, 60_000)
})

describe("SemaphoreRevocationProver", () => {
    it("throws MEMBER_NOT_IN_GROUP without generating a proof when the identity is not a mirrored member", async () => {
        const identity = new Identity("not-a-member-either")
        const currentGroup = jest.fn(async () => new Group([1n, 2n, 3n]))
        const groupMirror: GroupMirror = { currentGroup }
        const prover = new SemaphoreRevocationProver({
            identity,
            groupMirror,
            registry: { chainId: 1n, address: REGISTRY_ADDRESS }
        })

        const proving = prover.prove({ action: RevocationAction.Revoke, revocationCommitment: 42n })

        await expect(proving).rejects.toMatchObject({ code: "MEMBER_NOT_IN_GROUP" })
        expect(currentGroup).toHaveBeenCalledTimes(1)
    })

    it("proves against the group the mirror reports, not a stale one", async () => {
        const identity = new Identity("a-member")
        const group = new Group([identity.commitment, 2n])
        const prover = new SemaphoreRevocationProver({
            identity,
            groupMirror: { currentGroup: async () => group },
            registry: REGISTRY
        })

        const proof = await prover.prove({ action: RevocationAction.Revoke, revocationCommitment: 42n })

        expect(proof.merkleTreeRoot).toBe(BigInt(group.root))
    }, 60_000)
})

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

beforeAll(async () => {
    curve = await getCurveFromName("bn128")
})

afterAll(async () => {
    await curve.terminate()
})
