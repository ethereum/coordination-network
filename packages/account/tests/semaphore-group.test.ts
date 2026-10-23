import { describe, expect, it, jest } from "@jest/globals"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { createPublicClient } from "viem"
import { fetchPaymasterSemaphoreGroup } from "../src/semaphore-group"

jest.mock("viem", () => ({
    ...jest.requireActual<typeof import("viem")>("viem"),
    createPublicClient: jest.fn()
}))

const GROUP = {
    rpcUrl: "http://127.0.0.1:8545",
    semaphoreContract: "0x0000000000000000000000000000000000000001" as const,
    groupId: 0n,
    startBlock: 100n,
    blockScanWindowSize: 10n
}
const OTHER_GROUP_ID = 1n
const FIRST_MEMBER = new Identity("a").commitment
const SECOND_MEMBER = new Identity("b").commitment
const REPLACEMENT_MEMBER = new Identity("c").commitment

describe("fetchPaymasterSemaphoreGroup", () => {
    it("builds the group from members added one at a time", async () => {
        const getLogs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([
            { eventName: "MemberAdded", args: { groupId: GROUP.groupId, index: 0n, identityCommitment: FIRST_MEMBER } },
            { eventName: "MemberAdded", args: { groupId: GROUP.groupId, index: 1n, identityCommitment: SECOND_MEMBER } }
        ])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => GROUP.startBlock,
            getLogs,
            readContract: async () => new Group([FIRST_MEMBER, SECOND_MEMBER]).root
        } as never)

        const group = await fetchPaymasterSemaphoreGroup(GROUP)

        expect(group.members).toEqual([FIRST_MEMBER, SECOND_MEMBER])
    })

    it("builds the group from members added together", async () => {
        const getLogs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([
            {
                eventName: "MembersAdded",
                args: { groupId: GROUP.groupId, startIndex: 0n, identityCommitments: [FIRST_MEMBER, SECOND_MEMBER] }
            }
        ])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => GROUP.startBlock,
            getLogs,
            readContract: async () => new Group([FIRST_MEMBER, SECOND_MEMBER]).root
        } as never)

        const group = await fetchPaymasterSemaphoreGroup(GROUP)

        expect(group.members).toEqual([FIRST_MEMBER, SECOND_MEMBER])
    })

    it("replaces an updated member", async () => {
        const getLogs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([
            { eventName: "MemberAdded", args: { groupId: GROUP.groupId, index: 0n, identityCommitment: FIRST_MEMBER } },
            {
                eventName: "MemberUpdated",
                args: {
                    groupId: GROUP.groupId,
                    index: 0n,
                    identityCommitment: FIRST_MEMBER,
                    newIdentityCommitment: REPLACEMENT_MEMBER
                }
            }
        ])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => GROUP.startBlock,
            getLogs,
            readContract: async () => new Group([REPLACEMENT_MEMBER]).root
        } as never)

        const group = await fetchPaymasterSemaphoreGroup(GROUP)

        expect(group.members).toEqual([REPLACEMENT_MEMBER])
    })

    it("leaves a removed member as an empty slot", async () => {
        const getLogs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([
            { eventName: "MemberAdded", args: { groupId: GROUP.groupId, index: 0n, identityCommitment: FIRST_MEMBER } },
            {
                eventName: "MemberAdded",
                args: { groupId: GROUP.groupId, index: 1n, identityCommitment: SECOND_MEMBER }
            },
            {
                eventName: "MemberRemoved",
                args: { groupId: GROUP.groupId, index: 0n, identityCommitment: FIRST_MEMBER }
            }
        ])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => GROUP.startBlock,
            getLogs,
            readContract: async () => new Group([0n, SECOND_MEMBER]).root
        } as never)

        const group = await fetchPaymasterSemaphoreGroup(GROUP)

        expect(group.members).toEqual([0n, SECOND_MEMBER])
    })

    it("ignores members of other groups", async () => {
        const getLogs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([
            { eventName: "MemberAdded", args: { groupId: GROUP.groupId, index: 0n, identityCommitment: FIRST_MEMBER } },
            {
                eventName: "MemberAdded",
                args: { groupId: OTHER_GROUP_ID, index: 0n, identityCommitment: SECOND_MEMBER }
            }
        ])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => GROUP.startBlock,
            getLogs,
            readContract: async () => new Group([FIRST_MEMBER]).root
        } as never)

        const group = await fetchPaymasterSemaphoreGroup(GROUP)

        expect(group.members).toEqual([FIRST_MEMBER])
    })

    it("rejects a rebuilt group whose root the chain does not have", async () => {
        const getLogs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([
            {
                eventName: "MemberAdded",
                args: { groupId: GROUP.groupId, index: 0n, identityCommitment: FIRST_MEMBER }
            }
        ])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => GROUP.startBlock,
            getLogs,
            readContract: async () => new Group([FIRST_MEMBER, SECOND_MEMBER]).root
        } as never)

        await expect(fetchPaymasterSemaphoreGroup(GROUP)).rejects.toThrow("does not match the chain's")
    })

    it("requests logs in windows of the given size up to the latest block", async () => {
        const getLogs = jest
            .fn<(request: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]>>()
            .mockResolvedValue([])
        jest.mocked(createPublicClient).mockReturnValue({
            getBlockNumber: async () => 145n,
            getLogs,
            readContract: async () => new Group([]).root
        } as never)

        await fetchPaymasterSemaphoreGroup(GROUP)

        const requestedWindows = getLogs.mock.calls.map(([{ fromBlock, toBlock }]) => [fromBlock, toBlock])
        expect(requestedWindows).toEqual([
            [100n, 109n],
            [110n, 119n],
            [120n, 129n],
            [130n, 139n],
            [140n, 145n]
        ])
    })
})
