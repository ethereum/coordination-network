// Read at call time, not capture time, so a test can flip it after the (memoised) client already
// exists and still change what its next `readContract` call does.
const mockChainReachable = { value: true }
const mockIdentityResult = { value: "0x1234" as unknown }
type MockReadCall = { address?: string; functionName: string; args: unknown[]; rpcUrl: string; blockNumber?: bigint }
const mockReadCalls: MockReadCall[] = []
// Answers one read on its own, for a test that needs different members to answer differently.
const mockReadFor: { value: ((call: MockReadCall) => unknown) | null } = { value: null }
// `null` makes `getBlockNumber` fail.
const mockBlockNumber: { value: bigint | null } = { value: 42n }

jest.mock("viem", () => {
    const actual = jest.requireActual("viem")
    return {
        ...actual,
        http: jest.fn((url: string) => ({ url })),
        createPublicClient: jest.fn(({ transport }: { transport: { url: string } }) => ({
            getBlockNumber: jest.fn(async () => {
                if (mockBlockNumber.value === null) throw new Error("connect ECONNREFUSED")
                return mockBlockNumber.value
            }),
            readContract: jest.fn(async (call: Omit<MockReadCall, "rpcUrl">) => {
                const read = { ...call, rpcUrl: transport.url }
                mockReadCalls.push(read)
                if (!mockChainReachable.value) throw new Error("connect ECONNREFUSED")
                return mockReadFor.value ? mockReadFor.value(read) : mockIdentityResult.value
            })
        }))
    }
})

import type { Hex } from "@coordination-network/identity"
import {
    createMemberDirectory,
    createRootAuthority,
    readChainRoots,
    readIsRegistered,
    readIssuerKeyLeaves
} from "../chain-reads"
import type { StackDescriptor, StackMember } from "../config"

const rpcUrl = "http://192.168.1.10:8545"
const identityRegistry = "0x1111111111111111111111111111111111111111" as Hex
const networkId = `0x${"22".repeat(32)}` as Hex

beforeEach(() => {
    mockChainReachable.value = true
    mockIdentityResult.value = "0x1234"
    mockReadCalls.length = 0
    mockReadFor.value = null
    mockBlockNumber.value = 42n
})

describe("readIsRegistered", () => {
    it("is true once identity(networkId) returns a non-empty meta-stealth address", async () => {
        expect(await readIsRegistered(rpcUrl, identityRegistry, networkId)).toBe(true)
    })

    it("is false while the registry entry is still the empty default", async () => {
        mockIdentityResult.value = "0x"
        expect(await readIsRegistered(rpcUrl, identityRegistry, networkId)).toBe(false)
    })

    it("propagates a chain-read failure to the caller", async () => {
        mockChainReachable.value = false
        await expect(readIsRegistered(rpcUrl, identityRegistry, networkId)).rejects.toThrow("ECONNREFUSED")
    })
})

describe("readIssuerKeyLeaves", () => {
    const approvedIssuerSet = "0x3333333333333333333333333333333333333333" as Hex

    it("reads issuerKeysOf(networkId) from the approved issuer set", async () => {
        mockIdentityResult.value = [5n, 6n]

        expect(await readIssuerKeyLeaves(rpcUrl, approvedIssuerSet, networkId)).toEqual([5n, 6n])
        expect(mockReadCalls).toEqual([
            expect.objectContaining({ address: approvedIssuerSet, functionName: "issuerKeysOf", args: [networkId] })
        ])
    })

    it("propagates a chain-read failure to the caller", async () => {
        mockChainReachable.value = false
        await expect(readIssuerKeyLeaves(rpcUrl, approvedIssuerSet, networkId)).rejects.toThrow("ECONNREFUSED")
    })
})

const stackWith = (overrides: Pick<StackDescriptor, "rpcUrl" | "approvedIssuerSet" | "members">): StackDescriptor => ({
    chainId: 31337,
    identityRegistry,
    announcer: "0x2222222222222222222222222222222222222222",
    revocation: {
        address: "0x3333333333333333333333333333333333333333",
        registry: "0x3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a",
        registryId: "1"
    },
    semaphore: "0x4444444444444444444444444444444444444444",
    networkMemberRegistry: "0x5555555555555555555555555555555555555555",
    networkMemberGroup: "0x6666666666666666666666666666666666666666",
    networkMemberGovernance: "0x7777777777777777777777777777777777777777",
    governanceSafe: "0x9999999999999999999999999999999999999999",
    entryPoint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    paymaster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    accountImplementation: "0xcccccccccccccccccccccccccccccccccccccccc",
    bundlerUrl: "http://192.168.1.10:4337",
    dashboardUrl: "http://192.168.1.10:8080",
    ...overrides
})

describe("createMemberDirectory", () => {
    const memberAt = (id: Hex): StackMember => ({
        name: `member-${id.slice(2, 6)}`,
        networkId: id,
        serverUrl: "http://192.168.1.10:3001",
        authAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
        governanceSigner: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        role: "founder",
        brand: { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" }
    })
    const memberA = `0x${"aa".repeat(32)}` as Hex
    const memberB = `0x${"bb".repeat(32)}` as Hex
    const memberC = `0x${"cc".repeat(32)}` as Hex
    const stack = stackWith({
        rpcUrl,
        approvedIssuerSet: "0x3333333333333333333333333333333333333333",
        members: [memberAt(memberA), memberAt(memberB), memberAt(memberC)]
    })
    // Each member's list is its own, so a wrong pick shows up in the answer.
    const leavesByMember: Record<string, bigint[]> = { [memberA]: [1n], [memberB]: [2n], [memberC]: [3n] }
    const answerPerMember = (): void => {
        mockReadFor.value = (call) => leavesByMember[call.args[0] as string]
    }
    const asked = (): unknown[] => mockReadCalls.map((call) => call.args[0])

    it("reads against the stack that is scanned when the question is asked", async () => {
        answerPerMember()
        let current: StackDescriptor | null = null
        const directory = createMemberDirectory(() => current)
        current = stack

        expect(await directory.issuerKeyLeavesOf(memberB)).toEqual([2n])
    })

    // The provider sees every read, so asking for one member alone would name the issuer.
    it("queries every scanned member, whichever one is asked about", async () => {
        answerPerMember()
        const directory = createMemberDirectory(() => stack)

        expect(await directory.issuerKeyLeavesOf(memberC)).toEqual([3n])
        expect(asked().sort()).toEqual([memberA, memberB, memberC])
    })

    it("answers an id that is not a scanned member with no keys, and no read carries it", async () => {
        answerPerMember()
        const directory = createMemberDirectory(() => stack)
        const stranger = `0x${"dd".repeat(32)}` as Hex

        expect(await directory.issuerKeyLeavesOf(stranger)).toEqual([])
        expect(asked()).not.toContain(stranger)
        expect(asked().sort()).toEqual(stack.members.map((member) => member.networkId).sort())
    })

    it("matches the id case-insensitively", async () => {
        answerPerMember()
        const directory = createMemberDirectory(() => stack)

        expect(await directory.issuerKeyLeavesOf(`0x${"BB".repeat(32)}` as Hex)).toEqual([2n])
    })

    it("answers from the claimed member even when another member's read fails", async () => {
        mockReadFor.value = (call) => {
            if (call.args[0] === memberA) throw new Error("connect ECONNREFUSED")
            return leavesByMember[call.args[0] as string]
        }
        const directory = createMemberDirectory(() => stack)

        expect(await directory.issuerKeyLeavesOf(memberB)).toEqual([2n])
    })

    it("throws when the claimed member's own read fails", async () => {
        mockReadFor.value = (call) => {
            if (call.args[0] === memberB) throw new Error("connect ECONNREFUSED")
            return leavesByMember[call.args[0] as string]
        }
        const directory = createMemberDirectory(() => stack)

        await expect(directory.issuerKeyLeavesOf(memberB)).rejects.toThrow("ECONNREFUSED")
    })

    it("reads a stack that replaced the earlier one afresh, from its own node and contract", async () => {
        answerPerMember()
        const replacement = stackWith({
            rpcUrl: "http://192.168.1.11:8545",
            approvedIssuerSet: "0x4444444444444444444444444444444444444444",
            members: [memberAt(memberA)]
        })
        let current: StackDescriptor | null = stack
        const directory = createMemberDirectory(() => current)

        await directory.issuerKeyLeavesOf(memberA)
        mockReadCalls.length = 0
        current = replacement
        await directory.issuerKeyLeavesOf(memberA)

        expect(mockReadCalls).toEqual([
            expect.objectContaining({ address: replacement.approvedIssuerSet, rpcUrl: replacement.rpcUrl })
        ])
    })

    it("fails closed when no stack has been scanned, without touching the chain", async () => {
        const directory = createMemberDirectory(() => null)

        await expect(directory.issuerKeyLeavesOf(networkId)).rejects.toThrow("no stack")
        expect(mockReadCalls).toEqual([])
    })
})

const rootReads: Record<string, bigint> = { issuerSetRoot: 11n, getLeafCount: 3n, getRevocationRoot: 22n }

describe("readChainRoots", () => {
    const approvedIssuerSet = "0x3333333333333333333333333333333333333333" as Hex
    const revocationService = "0x4444444444444444444444444444444444444444" as Hex

    it("reads issuerSetRoot and getLeafCount from the issuer set and getRevocationRoot(registryId) from the revocation service", async () => {
        mockReadFor.value = (call) => rootReads[call.functionName]

        expect(await readChainRoots(rpcUrl, approvedIssuerSet, revocationService, 7n)).toEqual({
            approvedIssuerRoot: 11n,
            approvedIssuerLeafCount: 3,
            revocationRoot: 22n
        })
        expect(mockReadCalls).toEqual([
            expect.objectContaining({ address: approvedIssuerSet, functionName: "issuerSetRoot" }),
            expect.objectContaining({ address: approvedIssuerSet, functionName: "getLeafCount" }),
            expect.objectContaining({ address: revocationService, functionName: "getRevocationRoot", args: [7n] })
        ])
    })

    it("pins all three reads to the one block getBlockNumber returned", async () => {
        mockReadFor.value = (call) => rootReads[call.functionName]
        mockBlockNumber.value = 99n

        await readChainRoots(rpcUrl, approvedIssuerSet, revocationService, 7n)

        expect(mockReadCalls).toHaveLength(3)
        expect(mockReadCalls.map((call) => call.blockNumber)).toEqual([99n, 99n, 99n])
    })

    it("propagates a chain-read failure to the caller", async () => {
        mockChainReachable.value = false
        await expect(readChainRoots(rpcUrl, approvedIssuerSet, revocationService, 7n)).rejects.toThrow("ECONNREFUSED")
    })
})

describe("createRootAuthority", () => {
    const stack = stackWith({
        rpcUrl,
        approvedIssuerSet: "0x8888888888888888888888888888888888888888",
        members: []
    })

    it("reads the roots from the stack that is scanned when the question is asked", async () => {
        mockReadFor.value = (call) => rootReads[call.functionName]
        let current: StackDescriptor | null = null
        const roots = createRootAuthority(() => current)
        current = stack

        expect(await roots.currentRoots()).toEqual({
            approvedIssuerRoot: 11n,
            approvedIssuerLeafCount: 3,
            revocationRoot: 22n
        })
        expect(mockReadCalls).toEqual([
            expect.objectContaining({ address: stack.approvedIssuerSet, functionName: "issuerSetRoot", rpcUrl }),
            expect.objectContaining({ address: stack.approvedIssuerSet, functionName: "getLeafCount", rpcUrl }),
            expect.objectContaining({ address: stack.revocation.address, args: [1n], rpcUrl })
        ])
    })

    it("rejects when the block number cannot be read, making no contract read", async () => {
        mockBlockNumber.value = null
        const roots = createRootAuthority(() => stack)

        await expect(roots.currentRoots()).rejects.toThrow("ECONNREFUSED")
        expect(mockReadCalls).toEqual([])
    })

    it.each(["issuerSetRoot", "getLeafCount", "getRevocationRoot"])(
        "rejects when the %s read fails",
        async (failing) => {
            mockReadFor.value = (call) => {
                if (call.functionName === failing) throw new Error("connect ECONNREFUSED")
                return 1n
            }
            const roots = createRootAuthority(() => stack)

            await expect(roots.currentRoots()).rejects.toThrow("ECONNREFUSED")
        }
    )

    it("fails closed when no stack has been scanned, without touching the chain", async () => {
        const roots = createRootAuthority(() => null)

        await expect(roots.currentRoots()).rejects.toThrow("no stack")
        expect(mockReadCalls).toEqual([])
    })
})
