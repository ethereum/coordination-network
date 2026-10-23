import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import {
    encodeAbiParameters,
    encodeEventTopics,
    getAddress,
    parseAbiParameters,
    toEventSelector,
    type Address,
    type Hex,
    type PublicClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Hex32 } from "@coordination-network/credential"
import {
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    NETWORK_MEMBER_REGISTRY_ABI,
    memberAccountKey
} from "@coordination-network/network-member-governance"
import type { MemberStatus } from "./dashboard"
import {
    buildDashboardState,
    FLOW_TITLES,
    createDashboardGatherer,
    hintBetween,
    hintCounts,
    startDashboard,
    StackActivityLog,
    type DashboardInputs,
    type DashboardState,
    type GatherDashboardStateDeps,
    type HintCounts,
    type MemberServerState
} from "./dashboard"
import type { StackDescriptor } from "./serve"
import { dashboardHeaders, type StackSecrets } from "./stack-secrets"

const MEMBER_A_NETWORK_ID = `0x${"aa".repeat(32)}` as Hex32
const MEMBER_B_NETWORK_ID = `0x${"bb".repeat(32)}` as Hex32

const STACK: StackDescriptor = {
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31338,
    identityRegistry: `0x${"01".repeat(20)}`,
    announcer: `0x${"02".repeat(20)}`,
    revocation: {
        address: `0x${"03".repeat(20)}`,
        registry: `0x${"0c".repeat(20)}`,
        registryId: "1"
    },
    semaphore: `0x${"04".repeat(20)}`,
    networkMemberRegistry: `0x${"05".repeat(20)}`,
    networkMemberGroup: `0x${"06".repeat(20)}`,
    networkMemberGovernance: `0x${"07".repeat(20)}`,
    approvedIssuerSet: `0x${"08".repeat(20)}`,
    governanceSafe: `0x${"09".repeat(20)}`,
    entryPoint: `0x${"0a".repeat(20)}`,
    paymaster: `0x${"0b".repeat(20)}`,
    accountImplementation: `0x${"0c".repeat(20)}`,
    bundlerUrl: "http://127.0.0.1:4337",
    dashboardUrl: "http://127.0.0.1:8080",
    members: [
        {
            name: "Org 1",
            networkId: MEMBER_A_NETWORK_ID,
            serverUrl: "http://127.0.0.1:3001",
            authAddress: `0x${"0d".repeat(20)}`,
            governanceSigner: `0x${"0e".repeat(20)}`,
            role: "founder",
            brand: { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" },
            scheme: "member-a"
        },
        {
            name: "Org 2",
            networkId: MEMBER_B_NETWORK_ID,
            serverUrl: "http://127.0.0.1:3002",
            authAddress: `0x${"0f".repeat(20)}`,
            governanceSigner: `0x${"10".repeat(20)}`,
            role: "candidate",
            brand: { accent: "#f5b400", onAccent: "#17201c", accentSoft: "#fdf1cc", accentInk: "#8a5a00" }
        }
    ]
}

const SECRETS: StackSecrets = {
    dashboardKey: "d".repeat(64),
    memberServerTokens: { [MEMBER_A_NETWORK_ID]: "member-token-a", [MEMBER_B_NETWORK_ID]: "member-token-b" }
}

function memberStatus(overrides: Partial<MemberStatus> = {}): MemberStatus {
    return {
        networkId: MEMBER_A_NETWORK_ID,
        displayName: "Org 1",
        authAddress: STACK.members[0].authAddress,
        membership: {
            status: "approved",
            safe: { address: STACK.governanceSafe, threshold: 1, owners: [STACK.members[0].governanceSigner] },
            identityRegistered: true,
            issuerKeyPublished: true
        },
        issuerKey: { x: "1", y: "2", published: true },
        issuerSet: { address: STACK.approvedIssuerSet, root: "3", size: 1 },
        counts: {
            registrations: 0,
            existingRegistrations: 0,
            credentials: 0,
            revocations: 0,
            verifications: 0,
            rejectedVerifications: 0
        },
        recentActivity: [],
        ...overrides
    }
}

function inputs(overrides: Partial<DashboardInputs> = {}): DashboardInputs {
    return {
        stack: STACK,
        chain: { blockNumber: 42n, chainId: STACK.chainId, rpcUrl: STACK.rpcUrl },
        paymaster: {
            address: STACK.paymaster,
            deposit: 1_000_000_000_000_000_000n,
            maxCostPerOp: 10_000_000_000_000_000n,
            operations: [
                {
                    hash: `0x${"aa".repeat(32)}` as Hex,
                    sender: `0x${"11".repeat(20)}` as Address,
                    gasCost: 123_456n,
                    success: true
                }
            ]
        },
        safe: {
            address: STACK.governanceSafe,
            threshold: 1,
            owners: [STACK.members[0].governanceSigner],
            approvals: [true, false],
            pendingJoinRequests: [
                {
                    networkId: MEMBER_B_NETWORK_ID,
                    semaphoreCommitment: 987_654_321n,
                    governanceSigner: STACK.members[1].governanceSigner,
                    metadataURI: "https://member-b.example"
                }
            ]
        },
        bundler: {
            address: `0x${"22".repeat(20)}` as Address,
            balance: 100_000_000_000_000_000_000n,
            nonce: 3,
            recent: [
                { userOpHash: `0x${"aa".repeat(32)}` as Hex, sender: `0x${"11".repeat(20)}` as Address, success: true }
            ]
        },
        registrations: 1,
        issuerKeys: 1,
        members: [
            {
                name: "Org 1",
                url: STACK.members[0].serverUrl,
                healthy: true,
                status: memberStatus({
                    counts: {
                        registrations: 1,
                        existingRegistrations: 0,
                        credentials: 0,
                        revocations: 1,
                        verifications: 0,
                        rejectedVerifications: 0
                    }
                })
            },
            { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
        ],
        activity: [{ at: 1700000000000, kind: "deploy", message: "deployed the registry" }],
        ...overrides
    }
}

test("buildDashboardState turns every bigint field into a decimal string", () => {
    const state = buildDashboardState(inputs())

    assert.equal(state.chain.blockNumber, "42")
    assert.equal(state.paymaster.deposit, "1000000000000000000")
    assert.equal(state.paymaster.maxCostPerOp, "10000000000000000")
    assert.equal(state.paymaster.operations[0].gasCost, "123456")
    assert.equal(state.bundler.balance, "100000000000000000000")
    assert.equal(state.safe.pendingJoinRequests[0].semaphoreCommitment, "987654321")
})

test("buildDashboardState builds the contracts table from every stack.json address", () => {
    const state = buildDashboardState(inputs())

    assert.deepEqual(state.contracts, {
        identityRegistry: STACK.identityRegistry,
        announcer: STACK.announcer,
        revocation: STACK.revocation.address,
        semaphore: STACK.semaphore,
        networkMemberRegistry: STACK.networkMemberRegistry,
        networkMemberGroup: STACK.networkMemberGroup,
        networkMemberGovernance: STACK.networkMemberGovernance,
        approvedIssuerSet: STACK.approvedIssuerSet,
        governanceSafe: STACK.governanceSafe,
        entryPoint: STACK.entryPoint,
        paymaster: STACK.paymaster,
        accountImplementation: STACK.accountImplementation
    })
})

test("buildDashboardState matches each stack member to its own approval by index", () => {
    const state = buildDashboardState(inputs())

    assert.deepEqual(
        state.safe.members.map((member) => ({ name: member.name, role: member.role, approved: member.approved })),
        [
            { name: "Org 1", role: "founder", approved: true },
            { name: "Org 2", role: "candidate", approved: false }
        ]
    )
})

test("buildDashboardState handles zero stack members while still listing a pending join request, defaulting an absent metadataURI to an empty string", () => {
    const state = buildDashboardState(
        inputs({
            stack: { ...STACK, members: [] },
            safe: {
                address: STACK.governanceSafe,
                threshold: 1,
                owners: [],
                approvals: [],
                pendingJoinRequests: [
                    {
                        networkId: MEMBER_B_NETWORK_ID,
                        semaphoreCommitment: 1n,
                        governanceSigner: STACK.members[1].governanceSigner,
                        metadataURI: undefined
                    }
                ]
            },
            members: []
        })
    )

    assert.deepEqual(state.safe.members, [])
    assert.deepEqual(state.members, [])
    assert.equal(state.safe.pendingJoinRequests.length, 1)
    assert.equal(state.safe.pendingJoinRequests[0].metadataURI, "")
    assert.equal(state.safe.pendingJoinRequests[0].semaphoreCommitment, "1")
})

test("buildDashboardState carries the stack descriptor and activity ring through unchanged", () => {
    const state = buildDashboardState(inputs())

    assert.equal(state.stack, STACK)
    assert.deepEqual(state.activity, [{ at: 1700000000000, kind: "deploy", message: "deployed the registry" }])
    assert.deepEqual(state.members, inputs().members)
})

test("buildDashboardState's network setup panel carries admission, issuer keys, the Safe, and any pending join requests", () => {
    const state = buildDashboardState(inputs())

    assert.deepEqual(state.networkSetup, {
        membersAdmitted: 1,
        membersTotal: 2,
        issuerKeysPublished: 1,
        safeThreshold: 1,
        safeOwners: [STACK.members[0].governanceSigner],
        pendingJoinRequests: [
            {
                networkId: MEMBER_B_NETWORK_ID,
                semaphoreCommitment: "987654321",
                governanceSigner: STACK.members[1].governanceSigner,
                metadataURI: "https://member-b.example"
            }
        ]
    })
})

test("buildDashboardState's network setup panel counts every org admitted once every approval is true, with no pending requests left", () => {
    const state = buildDashboardState(
        inputs({ safe: { ...inputs().safe, approvals: [true, true], pendingJoinRequests: [] } })
    )

    assert.equal(state.networkSetup.membersAdmitted, 2)
    assert.equal(state.networkSetup.membersTotal, 2)
    assert.deepEqual(state.networkSetup.pendingJoinRequests, [])
})

test("buildDashboardState's network setup panel carries a pending request even with nothing approved yet", () => {
    const state = buildDashboardState(inputs({ safe: { ...inputs().safe, approvals: [false, false] } }))

    assert.equal(state.networkSetup.membersAdmitted, 0)
    assert.equal(state.networkSetup.pendingJoinRequests.length, 1)
})

function flowSummary(state: DashboardState): { number: number; state: string; count: string }[] {
    return state.flows.map((row) => ({
        number: row.number,
        state: row.state,
        count: `${row.count.value} ${row.count.noun}`
    }))
}

const ZERO_MEMBERS: MemberServerState[] = [
    { name: "Org 1", url: STACK.members[0].serverUrl, healthy: true, status: memberStatus() },
    { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
]

test("buildDashboardState's flows sit at zero when nothing has happened yet", () => {
    const state = buildDashboardState(
        inputs({
            registrations: 0,
            issuerKeys: 0,
            paymaster: { ...inputs().paymaster, operations: [] },
            safe: { ...inputs().safe, approvals: [false, false], pendingJoinRequests: [] },
            members: ZERO_MEMBERS
        })
    )

    assert.deepEqual(flowSummary(state), [
        { number: 1, state: "current", count: "0 registered" },
        { number: 2, state: "waiting", count: "0 issued" },
        { number: 3, state: "waiting", count: "0 verified" },
        { number: 4, state: "waiting", count: "0 revoked" },
        { number: 5, state: "waiting", count: "0 matched" }
    ])
})

// A step keeps its own figure whether or not the demo has reached it: row 4 already counts a
// revocation while still reading "waiting".
test("buildDashboardState's flows carry each step's own count, reached or not", () => {
    const state = buildDashboardState(inputs())

    assert.deepEqual(flowSummary(state), [
        { number: 1, state: "done", count: "1 registered" },
        { number: 2, state: "current", count: "0 issued" },
        { number: 3, state: "waiting", count: "0 verified" },
        { number: 4, state: "waiting", count: "1 revoked" },
        { number: 5, state: "waiting", count: "0 matched" }
    ])
})

test("buildDashboardState's proof flow is done once a presentation has verified", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 1,
                            existingRegistrations: 0,
                            credentials: 1,
                            revocations: 0,
                            verifications: 2,
                            rejectedVerifications: 0
                        }
                    })
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )

    assert.deepEqual(state.flows[2].count, { value: 2, noun: "verified" })
    assert.equal(state.flows[2].state, "done")
})

test("buildDashboardState's revoke flow is done once a rejection follows a revocation, not from the revocation alone", () => {
    const revokedOnly = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 1,
                            existingRegistrations: 0,
                            credentials: 1,
                            revocations: 1,
                            verifications: 0,
                            rejectedVerifications: 0
                        }
                    })
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )
    // The revocation is counted, but the step is not finished until a proof fails because of it.
    assert.notEqual(revokedOnly.flows[3].state, "done")
    assert.equal(revokedOnly.flows[3].count.value, 1)

    const revokedThenRejected = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 1,
                            existingRegistrations: 0,
                            credentials: 1,
                            revocations: 1,
                            verifications: 0,
                            rejectedVerifications: 1
                        },
                        recentActivity: [
                            { at: 1700000001000, kind: "verification", message: "verification rejected: REVOKED" },
                            { at: 1700000000000, kind: "revocation", message: "revoked a credential" }
                        ]
                    })
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )
    assert.deepEqual(revokedThenRejected.flows[3].count, { value: 1, noun: "revoked" })
    assert.equal(revokedThenRejected.flows[3].state, "done")
})

test("buildDashboardState's revoke flow is not done when the rejection predates the revocation", () => {
    // Same counts as the success case above, but the rejection came first: a presentation
    // rejected for an unrelated reason (a replayed request id, say) before any revocation must
    // not read as the next proof failing because of one.
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 1,
                            existingRegistrations: 0,
                            credentials: 1,
                            revocations: 1,
                            verifications: 0,
                            rejectedVerifications: 1
                        },
                        recentActivity: [
                            { at: 1700000001000, kind: "revocation", message: "revoked a credential" },
                            { at: 1700000000000, kind: "verification", message: "verification rejected: REPLAY" }
                        ]
                    })
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )
    assert.notEqual(state.flows[3].state, "done")
})

test("buildDashboardState's 'another org, same person' flow is done once the second founder matched the record and then issued its own credential", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 1,
                            existingRegistrations: 0,
                            credentials: 0,
                            revocations: 0,
                            verifications: 0,
                            rejectedVerifications: 0
                        }
                    })
                },
                {
                    name: "Org 2",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 0,
                            existingRegistrations: 1,
                            credentials: 1,
                            revocations: 0,
                            verifications: 0,
                            rejectedVerifications: 0
                        },
                        recentActivity: [
                            { at: 1700000001000, kind: "credential", message: "issued a credential" },
                            { at: 1700000000000, kind: "registration", message: "found an existing registration" }
                        ]
                    })
                }
            ]
        })
    )

    assert.deepEqual(state.flows[4].count, { value: 1, noun: "matched" })
    assert.equal(state.flows[4].state, "done")
})

test("buildDashboardState's 'another org, same person' flow is not done when the second founder matched a record but hasn't issued its own credential yet", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({ counts: { ...memberStatus().counts, registrations: 1 } })
                },
                {
                    name: "Org 2",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({ counts: { ...memberStatus().counts, existingRegistrations: 1 } })
                }
            ]
        })
    )

    assert.equal(state.flows[4].count.value, 1)
    assert.notEqual(state.flows[4].state, "done")
})

test("buildDashboardState's 'another org, same person' flow is not done when the second founder issued its credential before matching the record", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({ counts: { ...memberStatus().counts, registrations: 1 } })
                },
                {
                    name: "Org 2",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: { ...memberStatus().counts, existingRegistrations: 1, credentials: 1 },
                        // Reversed from the success test above: the credential predates the match,
                        // so the two counts being positive is coincidence, not this flow completing.
                        recentActivity: [
                            { at: 1700000000000, kind: "credential", message: "issued a credential" },
                            { at: 1700000001000, kind: "registration", message: "found an existing registration" }
                        ]
                    })
                }
            ]
        })
    )

    assert.equal(state.flows[4].count.value, 1)
    assert.notEqual(state.flows[4].state, "done")
})

test("buildDashboardState's 'another org, same person' flow is not done when the first founder, not the second, holds the existing-registration and credential counts", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            ...memberStatus().counts,
                            registrations: 1,
                            existingRegistrations: 1,
                            credentials: 1
                        },
                        recentActivity: [
                            { at: 1700000001000, kind: "credential", message: "issued a credential" },
                            { at: 1700000000000, kind: "registration", message: "found an existing registration" }
                        ]
                    })
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )

    assert.equal(state.flows[4].count.value, 1)
    assert.notEqual(state.flows[4].state, "done")
})

test("buildDashboardState's live line is empty before either org has reported anything", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                { name: "Org 1", url: STACK.members[0].serverUrl, healthy: true, status: memberStatus() },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )

    assert.equal(state.liveLine, null)
})

test("buildDashboardState's live line names the one org that has reported something", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 1700000000000, kind: "credential", message: "issued a credential" }]
                    })
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )

    assert.deepEqual(state.liveLine, { name: "Org 1", message: "issued a credential", at: 1700000000000 })
})

test("buildDashboardState's live line picks the newer of two orgs' events", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 1700000000000, kind: "credential", message: "issued a credential" }]
                    })
                },
                {
                    name: "Org 2",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [
                            { at: 1700000005000, kind: "registration", message: "found an existing registration" }
                        ]
                    })
                }
            ]
        })
    )

    assert.deepEqual(state.liveLine, { name: "Org 2", message: "found an existing registration", at: 1700000005000 })
})

test("buildDashboardState's live line breaks a tie on equal timestamps in favour of the first org", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 1700000000000, kind: "credential", message: "Org 1's event" }]
                    })
                },
                {
                    name: "Org 2",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 1700000000000, kind: "registration", message: "Org 2's event" }]
                    })
                }
            ]
        })
    )

    assert.deepEqual(state.liveLine, { name: "Org 1", message: "Org 1's event", at: 1700000000000 })
})

test("buildDashboardState's live line still picks up the second org when it alone has reported anything", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                { name: "Org 1", url: STACK.members[0].serverUrl, healthy: true, status: memberStatus() },
                {
                    name: "Org 2",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 1700000000000, kind: "credential", message: "issued a credential" }]
                    })
                }
            ]
        })
    )

    assert.deepEqual(state.liveLine, { name: "Org 2", message: "issued a credential", at: 1700000000000 })
})

function startFakeMemberServer(status: unknown): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
        if (request.url === "/health") {
            response.writeHead(200).end()
            return
        }
        if (request.url === "/v1/status") {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status))
            return
        }
        response.writeHead(404).end()
    })
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number }
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((res) => server.close(() => res()))
            })
        })
    })
}

/** Every read the dashboard gatherer makes, keyed by function name; enough to let it run against
 *  a stack with no real chain behind it. */
function fakePublicClient(): PublicClient {
    return {
        getBlockNumber: async () => 1n,
        getBalance: async () => 0n,
        getTransactionCount: async () => 0,
        getLogs: async () => [],
        readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "getOwners") return []
            if (functionName === "isApproved") return false
            return 0n
        }
    } as unknown as PublicClient
}

test("createDashboardGatherer leaves a member's status null, instead of throwing, when its /v1/status body fails schema validation", async () => {
    const validStatus = {
        networkId: MEMBER_A_NETWORK_ID,
        displayName: "Org 1",
        authAddress: STACK.members[0].authAddress,
        membership: {
            status: "approved",
            safe: { address: STACK.governanceSafe, threshold: 1, owners: [STACK.members[0].governanceSigner] },
            identityRegistered: true,
            issuerKeyPublished: true
        },
        issuerKey: { x: "1", y: "2", published: true },
        issuerSet: { address: STACK.approvedIssuerSet, root: "3", size: 1 },
        counts: {
            registrations: 0,
            existingRegistrations: 0,
            credentials: 0,
            revocations: 0,
            verifications: 0,
            rejectedVerifications: 0
        },
        recentActivity: []
    }
    // A non-hex authAddress and a missing counts object: two independent reasons safeParse rejects it.
    const malformedStatus = {
        networkId: MEMBER_B_NETWORK_ID,
        displayName: "Org 2",
        authAddress: "not-a-hex-address",
        membership: {
            status: "approved",
            safe: { address: STACK.governanceSafe, threshold: 1, owners: [] },
            identityRegistered: true,
            issuerKeyPublished: true
        },
        issuerKey: { x: "1", y: "2", published: true },
        issuerSet: { address: null, root: "0", size: 0 }
    }

    const alpha = await startFakeMemberServer(validStatus)
    const beta = await startFakeMemberServer(malformedStatus)
    try {
        const stack: StackDescriptor = {
            ...STACK,
            members: [
                { ...STACK.members[0], serverUrl: alpha.url },
                { ...STACK.members[1], serverUrl: beta.url }
            ]
        }

        const state = await createDashboardGatherer({
            stack,
            secrets: SECRETS,
            publicClient: fakePublicClient(),
            deployBlock: 0n,
            bundler: {
                url: "http://fake-bundler.test",
                address: `0x${"33".repeat(20)}` as Address,
                close: async () => {},
                recent: () => []
            },
            activity: new StackActivityLog()
        })()

        assert.deepEqual(
            state.members.map((member) => ({
                name: member.name,
                healthy: member.healthy,
                hasStatus: member.status !== null
            })),
            [
                { name: "Org 1", healthy: true, hasStatus: true },
                { name: "Org 2", healthy: true, hasStatus: false }
            ]
        )
    } finally {
        await alpha.close()
        await beta.close()
    }
})

test("createDashboardGatherer lists a join request logged with the account key, under the id derived from it", async () => {
    const { memberNetworkId, accountKeyX, accountKeyY } = memberAccountKey(
        privateKeyToAccount(`0x${"15".repeat(32)}`).publicKey
    )
    const governanceSigner = getAddress(`0x${"44".repeat(20)}`)
    const requestLog = {
        address: STACK.networkMemberRegistry,
        topics: encodeEventTopics({
            abi: NETWORK_MEMBER_REGISTRY_ABI,
            eventName: "NetworkMemberJoinRequested",
            args: { memberNetworkId }
        }) as Hex[],
        data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, address, string"), [
            accountKeyX,
            accountKeyY,
            777n,
            governanceSigner,
            "https://candidate.example"
        ])
    }
    const joinRequestEvents: unknown[] = []
    const publicClient = {
        ...fakePublicClient(),
        getLogs: async ({ event }: { event: { name: string } }) => {
            if (event.name !== "NetworkMemberJoinRequested") return []
            joinRequestEvents.push(event)
            return [requestLog]
        }
    } as unknown as PublicClient

    const state = await createDashboardGatherer({
        stack: STACK,
        secrets: SECRETS,
        publicClient,
        deployBlock: 0n,
        bundler: {
            url: "http://fake-bundler.test",
            address: `0x${"33".repeat(20)}` as Address,
            close: async () => {},
            recent: () => []
        },
        activity: new StackActivityLog()
    })()

    assert.deepEqual(state.safe.pendingJoinRequests, [
        {
            networkId: memberNetworkId,
            semaphoreCommitment: "777",
            governanceSigner,
            metadataURI: "https://candidate.example"
        }
    ])
    // A stale local copy of the event would filter on a topic the registry no longer emits.
    assert.equal(joinRequestEvents.length, 1)
    assert.equal(
        toEventSelector(joinRequestEvents[0] as typeof NETWORK_MEMBER_JOIN_REQUESTED_EVENT),
        toEventSelector(NETWORK_MEMBER_JOIN_REQUESTED_EVENT)
    )
})

type LogRange = { address: Address; fromBlock: bigint; toBlock: bigint }

/** A chain whose head the test moves and whose `getLogs` requests it observes, holding no logs. */
function logChain(
    head: () => bigint,
    onLogs: (range: LogRange) => void,
    onHeadRead: (params: unknown) => void = () => {}
): PublicClient {
    return {
        ...fakePublicClient(),
        getBlockNumber: async (params?: unknown) => {
            onHeadRead(params)
            return head()
        },
        getLogs: async (range: LogRange) => {
            onLogs(range)
            return []
        }
    } as unknown as PublicClient
}

function memberlessDeps(
    publicClient: PublicClient,
    deployBlock: bigint,
    options: Partial<GatherDashboardStateDeps> = {}
): GatherDashboardStateDeps {
    return {
        stack: { ...STACK, members: [] },
        publicClient,
        deployBlock,
        bundler: {
            url: "http://fake-bundler.test",
            address: `0x${"33".repeat(20)}` as Address,
            close: async () => {},
            recent: () => []
        },
        activity: new StackActivityLog(),
        secrets: SECRETS,
        ...options
    }
}

test("createDashboardGatherer reads each log source once per block range, however often it refreshes", async () => {
    let head = 10n
    const ranges: string[] = []
    const deps = memberlessDeps(
        logChain(
            () => head,
            ({ address, fromBlock, toBlock }) => ranges.push(`${address.slice(0, 4)}:${fromBlock}-${toBlock}`)
        ),
        4n,
        { logConfirmations: 0n }
    )

    const gather = createDashboardGatherer(deps)
    await gather()
    await gather()
    head = 15n
    await gather()

    // Identity registry (0x01), network-member registry (0x05) and entry point (0x0a), sorted as text.
    assert.deepEqual(ranges.sort(), ["0x01:11-15", "0x01:4-10", "0x05:11-15", "0x05:4-10", "0x0a:11-15", "0x0a:4-10"])
})

test("createDashboardGatherer scans in windows when logWindowBlocks is set", async () => {
    const ranges: string[] = []
    const publicClient = logChain(
        () => 25n,
        ({ address, fromBlock, toBlock }) => {
            if (address === STACK.identityRegistry) ranges.push(`${fromBlock}-${toBlock}`)
        }
    )

    await createDashboardGatherer(memberlessDeps(publicClient, 5n, { logWindowBlocks: 10n }))()

    assert.deepEqual(ranges, ["5-14", "15-24", "25-25"])
})

test("createDashboardGatherer holds every log scan logConfirmations behind the head", async () => {
    const ranges: string[] = []
    const publicClient = logChain(
        () => 10n,
        ({ fromBlock, toBlock }) => ranges.push(`${fromBlock}-${toBlock}`)
    )

    await createDashboardGatherer(memberlessDeps(publicClient, 4n, { logConfirmations: 2n }))()

    assert.deepEqual(ranges, ["4-8", "4-8", "4-8"])
})

test("each dashboard gatherer keeps its own log indexes and options, even over one chain client", async () => {
    const ranges: string[] = []
    const publicClient = logChain(
        () => 25n,
        ({ address, fromBlock, toBlock }) => {
            if (address === STACK.identityRegistry) ranges.push(`${fromBlock}-${toBlock}`)
        }
    )

    // Same stack, client and deploy block: only the options tell the two gatherers apart.
    const deps = memberlessDeps(publicClient, 5n)

    await createDashboardGatherer({ ...deps, logWindowBlocks: 10n })()
    await createDashboardGatherer(deps)()

    assert.deepEqual(ranges, ["5-14", "15-24", "25-25", "5-25"])
})

test("createDashboardGatherer reads the head past viem's block-number cache", async () => {
    const headReads: unknown[] = []
    const publicClient = logChain(
        () => 10n,
        () => {},
        (params) => headReads.push(params)
    )

    await createDashboardGatherer(memberlessDeps(publicClient, 4n))()

    assert.deepEqual(headReads, [{ cacheTime: 0 }])
})

const CANDIDATE_KEY = memberAccountKey(privateKeyToAccount(`0x${"15".repeat(32)}`).publicKey)

function joinRequestLog(metadataURI: string) {
    return {
        address: STACK.networkMemberRegistry,
        blockNumber: 1n,
        topics: encodeEventTopics({
            abi: NETWORK_MEMBER_REGISTRY_ABI,
            eventName: "NetworkMemberJoinRequested",
            args: { memberNetworkId: CANDIDATE_KEY.memberNetworkId }
        }) as Hex[],
        data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, address, string"), [
            CANDIDATE_KEY.accountKeyX,
            CANDIDATE_KEY.accountKeyY,
            1n,
            STACK.members[1].governanceSigner,
            metadataURI
        ])
    }
}

test("a member with two join requests is checked for approval once and listed once with its latest request", async () => {
    const approvalReads: unknown[] = []
    const logs = [joinRequestLog("first"), joinRequestLog("second")]
    const publicClient = {
        ...fakePublicClient(),
        getLogs: async ({ address }: { address: Address }) => (address === STACK.networkMemberRegistry ? logs : []),
        readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
            if (functionName === "isApproved") {
                approvalReads.push(args[0])
                return false
            }
            return functionName === "getOwners" ? [] : 0n
        }
    } as unknown as PublicClient

    const state = await createDashboardGatherer(memberlessDeps(publicClient, 0n))()

    assert.deepEqual(approvalReads, [CANDIDATE_KEY.memberNetworkId])
    assert.deepEqual(
        state.safe.pendingJoinRequests.map((request) => request.metadataURI),
        ["second"]
    )
})

/** One panel's own body, isolated from its neighbours and from the inline script, whose source
 *  carries a copy of nearly every string the client can render. */
function panelBody(html: string, id: string): string {
    const match = html.split("<script>")[0].match(new RegExp(`id="panel-body-${id}">(.*?)</div></section>`, "s"))
    assert.ok(match, `panel ${id} not found`)
    return match[1]
}

/** One tab's own section, sliced at the next tab's. */
function tabSection(html: string, key: string): string {
    const start = html.indexOf(`<section role="tabpanel" id="tabpanel-${key}"`)
    assert.ok(start >= 0, `tab ${key} not found`)
    const next = html.indexOf(`<section role="tabpanel"`, start + 1)
    return html.slice(start, next === -1 ? html.indexOf("</main>", start) : next)
}

async function withDashboard(state: DashboardState, run: (base: string) => Promise<void>): Promise<void> {
    const dashboard = await startDashboard({
        stack: STACK,
        secrets: SECRETS,
        getState: async () => state,
        host: "127.0.0.1",
        port: 0
    })
    try {
        await run(dashboard.url)
    } finally {
        await dashboard.close()
    }
}

test("GET /api/state serves the fake state as JSON", async () => {
    const state = buildDashboardState(inputs())
    await withDashboard(state, async (base) => {
        const response = await fetch(`${base}/api/state`)
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), state)
    })
})

test("GET /api/state carries the five flows", async () => {
    const state = buildDashboardState(inputs())
    await withDashboard(state, async (base) => {
        const response = await fetch(`${base}/api/state`)
        const body = await response.json()
        assert.equal(body.flows.length, 5)
        assert.deepEqual(
            body.flows.map((row: { title: string }) => row.title),
            [...FLOW_TITLES]
        )
    })
})

test("no open dashboard route carries a member server token or the dashboard key", async () => {
    // Pins that nothing passed in `secrets` reaches an open route.
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        for (const path of ["/", "/api/state", "/stack.json"]) {
            const body = await (await fetch(`${base}${path}`)).text()
            for (const secret of [SECRETS.dashboardKey, ...Object.values(SECRETS.memberServerTokens)]) {
                assert.equal(body.includes(secret), false, `${path} carries ${secret}`)
            }
        }
    })
})

test("GET /stack.json serves the stack descriptor", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const response = await fetch(`${base}/stack.json`)
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), STACK)
    })
})

test("GET / renders the dashboard's HTML with the fake state's addresses", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const response = await fetch(`${base}/`)
        assert.equal(response.status, 200)
        assert.match(response.headers.get("content-type") ?? "", /html/)
        const html = await response.text()
        assert.match(html, new RegExp(STACK.governanceSafe))
    })
})

test("GET / renders all five flow titles", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        for (const title of FLOW_TITLES) {
            assert.match(html, new RegExp(title))
        }
    })
})

test("GET / renders the network setup panel, and no panel of its own for the live line", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Network setup/)
        assert.doesNotMatch(html, /Just happened/)
        assert.doesNotMatch(html, /panel-body-live-line/)
    })
})

// The live line and the one instruction that advances the demo hang off the step the demo is on,
// which is the whole point of dropping the panel: one place to look instead of two to join up.
// The fixture has registered but issued nothing, so step 2 is where it is.
test("GET / hangs the live line and the next instruction off the current step", async () => {
    const state = buildDashboardState(inputs())
    state.liveLine = { name: "Member A", message: "registered an identity", at: Date.now() - 5_000 }
    await withDashboard(state, async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        const flow = panelBody(html, "flows")
        const current = flow.slice(flow.indexOf("flow-row flow-current"))
        assert.match(current, /2\. Verify and issue the credential/)
        assert.match(current, /Member A: registered an identity — just now/)
        assert.match(current, /Tap Issue in Member A, then approve it in the wallet\./)
        // Only the current step carries them.
        assert.equal(flow.match(/flow-next/g)?.length, 1)
        assert.equal(flow.match(/flow-current/g)?.length, 1)
    })
})

test("GET / draws each step as a state word and one figure, with no per-org breakdown", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const flow = panelBody(await (await fetch(`${base}/`)).text(), "flows")

        assert.match(flow, /<span class="flow-mark" aria-hidden="true">✓<\/span>/)
        assert.match(flow, /<span class="badge badge-success">Done<\/span>/)
        assert.match(flow, /<span class="badge badge-warning">Now<\/span>/)
        assert.match(flow, /<span class="badge badge-default">Waiting<\/span>/)
        assert.match(flow, /<span class="flow-figure">1<\/span><span class="flow-noun">registered<\/span>/)

        assert.doesNotMatch(flow, /Org 1: /)
        assert.doesNotMatch(flow, /rejected network-wide/)
    })
})

test("GET / gives the Flow tab a lead layout, so the feed sits beside the flow rather than under it", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()

        assert.match(tabSection(html, "flow"), /<div class="panel-grid panel-grid-lead">/)
        // Every other tab keeps the equal-width grid, which is what leaves the org status page
        // that shares this template alone.
        assert.match(tabSection(html, "orgs"), /<div class="panel-grid">/)
        assert.doesNotMatch(html, /panel-wide/)
    })
})

test("buildDashboardState advances the current step, and marks exactly one", () => {
    const nothingYet = buildDashboardState(inputs({ registrations: 0 }))
    assert.deepEqual(
        nothingYet.flows.map((flow) => flow.state),
        ["current", "waiting", "waiting", "waiting", "waiting"]
    )

    // One registration finishes step 1 and hands "current" to step 2.
    const registered = buildDashboardState(inputs())
    assert.deepEqual(
        registered.flows.map((flow) => flow.state),
        ["done", "current", "waiting", "waiting", "waiting"]
    )
    assert.equal(registered.flows.filter((flow) => flow.state === "current").length, 1)
})

// Two feeds in one panel: the orgs answer "what happened in the demo", the stack answers "what is
// the plumbing doing". The flow panel beside this carries neither any more.
test("GET / names the orgs' own events first, then the stack's, in Recent activity", async () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Member A",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 1700000000000, kind: "credential", message: "issued a credential" }]
                    })
                },
                {
                    name: "Member B",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [
                            { at: 1700000009000, kind: "verification", message: "verification rejected: REVOKED" }
                        ]
                    })
                }
            ]
        })
    )

    await withDashboard(state, async (base) => {
        const feed = panelBody(await (await fetch(`${base}/`)).text(), "activity")

        // Newest first, across orgs, each named by the org that reported it.
        assert.ok(feed.indexOf("<strong>Member B</strong>") < feed.indexOf("<strong>Member A</strong>"))
        assert.match(feed, /<strong>Member B<\/strong> verification rejected: REVOKED/)
        // Then the stack's own, below the divider and still carrying their kind.
        assert.ok(feed.indexOf("<strong>Member A</strong>") < feed.indexOf("feed-split"))
        assert.match(feed, /\[deploy\] deployed the registry/)
    })
})

// The ring holds a hundred, which rendered whole would stretch the flow panel beside it.
test("GET / shows only the newest of the stack's own entries, however many the ring holds", async () => {
    const log = new StackActivityLog()
    for (let index = 0; index < 40; index += 1) log.append("deploy", `step ${index}`)
    const state = buildDashboardState(inputs({ activity: log.recent() }))

    await withDashboard(state, async (base) => {
        const feed = panelBody(await (await fetch(`${base}/`)).text(), "activity")
        const stack = feed.slice(feed.indexOf("feed-split"))

        assert.equal(stack.match(/<li>/g)?.length, 15)
        assert.match(stack, /step 39/)
        assert.doesNotMatch(stack, /step 24/)
    })
})

test("buildDashboardState merges every org's activity newest first, and leaves an unreachable org out", () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Member A",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 20, kind: "credential", message: "issued a credential" }]
                    })
                },
                {
                    name: "Member B",
                    url: STACK.members[1].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        recentActivity: [{ at: 30, kind: "verification", message: "verified a presentation" }]
                    })
                },
                { name: "Member C", url: "http://127.0.0.1:3003", healthy: false, status: null }
            ]
        })
    )

    assert.deepEqual(
        state.orgActivity.map((entry) => `${entry.at} ${entry.name} ${entry.message}`),
        ["30 Member B verified a presentation", "20 Member A issued a credential"]
    )
})

// The mirror in pollingScript is hand-written, and only it runs after the first two seconds, so a
// server-only change looks correct on load and blanks the live line on the next poll.
test("the poll's own renderer is wired to the same state, and renders the same classes", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()

        assert.match(html, /setBody\("flows", flowsHtml\(state\.flows, state\.liveLine\)\)/)
        assert.match(html, /setBody\("activity", activityHtml\(state\)\)/)
        assert.doesNotMatch(html, /setBody\("live-line"/)

        // Every class and field the server-side renderers above emit has to appear in the mirror
        // too: only the mirror runs after the first two seconds.
        for (const token of [
            "flow-row flow-",
            "flow-mark",
            "flow-title",
            "flow-line",
            "flow-aside",
            "flow-figure",
            "flow-noun",
            "flow-live",
            "flow-next",
            "feed-at",
            "feed-split",
            "row.count.value",
            "esc(row.count.noun)",
            "esc(row.prompt)",
            "state.orgActivity"
        ]) {
            assert.ok(html.includes(token), `pollingScript is missing ${token}`)
        }
    })
})

test("GET / says nothing has happened yet when the live line is empty", async () => {
    const state = buildDashboardState(inputs())
    state.liveLine = null
    await withDashboard(state, async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Nothing has happened yet\./)
    })
})

test("GET / renders the live line's relative time in each of its three buckets", async () => {
    const state = buildDashboardState(inputs())

    state.liveLine = { name: "Org 1", message: "issued a credential", at: Date.now() - 5_000 }
    await withDashboard(state, async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Org 1: issued a credential — just now/)
    })

    state.liveLine = { name: "Org 1", message: "issued a credential", at: Date.now() - 65_000 }
    await withDashboard(state, async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Org 1: issued a credential — 1 min ago/)
    })

    state.liveLine = { name: "Org 1", message: "issued a credential", at: Date.now() - (59 * 60_000 + 5_000) }
    await withDashboard(state, async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Org 1: issued a credential — 59 min ago/)
    })

    state.liveLine = { name: "Org 1", message: "issued a credential", at: Date.now() - 61 * 60_000 }
    await withDashboard(state, async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Org 1: issued a credential — 1 hr ago/)
    })
})

test("GET / marks a healthy org's status unreadable on its own card, instead of just healthy", async () => {
    const state = buildDashboardState(
        inputs({
            members: [{ name: "Org 1", url: STACK.members[0].serverUrl, healthy: true, status: null }]
        })
    )
    await withDashboard(state, async (base) => {
        const card = panelBody(await (await fetch(`${base}/`)).text(), "orgs")
        assert.match(card, /<strong>Org 1<\/strong> <span class="badge badge-warning">status unreadable<\/span>/)
    })
})

test("GET / gives each org a card in its own brand colour, with its counts, its credentials, and a way to its page", async () => {
    const state = buildDashboardState(
        inputs({
            members: [
                {
                    name: "Org 1",
                    url: STACK.members[0].serverUrl,
                    healthy: true,
                    status: memberStatus({
                        counts: {
                            registrations: 2,
                            existingRegistrations: 0,
                            credentials: 1,
                            revocations: 1,
                            verifications: 3,
                            rejectedVerifications: 0
                        }
                    }),
                    credentials: [
                        {
                            id: "urn:uuid:11112222-3333-4444-5555-666677778888",
                            programme: "demo-programme",
                            country: "ZZZ",
                            issuedAt: 1700000000000,
                            expiresAt: 1800000000000,
                            revoked: false
                        }
                    ]
                },
                { name: "Org 2", url: STACK.members[1].serverUrl, healthy: false, status: null }
            ]
        })
    )
    await withDashboard(state, async (base) => {
        const orgs = panelBody(await (await fetch(`${base}/`)).text(), "orgs")
        assert.match(orgs, /<div class="org-card" style="--org-accent:#1d4ed8">/)
        assert.match(orgs, /<div class="org-card" style="--org-accent:#f5b400">/)
        assert.match(orgs, /2 registered · 1 issued · 1 revoked · 3 verified/)
        assert.match(orgs, /11112222 — demo-programme · ZZZ/)
        assert.match(
            orgs,
            new RegExp(
                `data-action="revoke" data-index="0" data-credential-id="urn:uuid:11112222-3333-4444-5555-666677778888"`
            )
        )
        assert.match(orgs, new RegExp(`<a href="${STACK.members[0].serverUrl}">Status page</a>`))
        assert.match(orgs, /<strong>Org 2<\/strong> <span class="badge badge-danger">unreachable<\/span>/)
    })
})

test("GET / keeps the stack QR in the open and folds the descriptor it carries", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        const panel = html.match(/id="panel-body-stack">(.*?)<\/div><\/section>/s)
        assert.ok(panel, "stack panel not found")
        const [beforeFold, insideFold] = panel[1].split("<details>")
        assert.match(beforeFold, /stack\.svg/)
        assert.match(insideFold, new RegExp(STACK.entryPoint))
    })
})

test("GET / opens on five tabs, each hidden until the page's own script picks one", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()

        assert.deepEqual(
            [...html.matchAll(/<button type="button" role="tab" id="tab-([a-z-]+)"[^>]*>([^<]+)<\/button>/g)].map(
                (match) => [match[1], match[2]]
            ),
            [
                ["flow", "Flow"],
                ["orgs", "Orgs"],
                ["network", "Network"],
                ["chain", "Chain"],
                ["connect", "Connect"]
            ]
        )
        assert.equal(html.match(/<section role="tabpanel"[^>]*hidden>/g)?.length, 5)
        assert.match(html, /<main class="tabbed" data-tab-scope="dashboard">/)
    })
})

test("GET / keeps every panel id where its tab is, so the poll's setBody still finds it", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()

        assert.deepEqual(
            {
                flow: [...tabSection(html, "flow").matchAll(/id="panel-body-([a-z-]+)"/g)].map((match) => match[1]),
                orgs: [...tabSection(html, "orgs").matchAll(/id="panel-body-([a-z-]+)"/g)].map((match) => match[1]),
                network: [...tabSection(html, "network").matchAll(/id="panel-body-([a-z-]+)"/g)].map(
                    (match) => match[1]
                ),
                chain: [...tabSection(html, "chain").matchAll(/id="panel-body-([a-z-]+)"/g)].map((match) => match[1]),
                connect: [...tabSection(html, "connect").matchAll(/id="panel-body-([a-z-]+)"/g)].map(
                    (match) => match[1]
                )
            },
            {
                flow: ["flows", "activity"],
                orgs: ["orgs"],
                network: ["network-setup", "safe"],
                chain: ["chain", "contracts", "paymaster", "bundler"],
                connect: ["stack"]
            }
        )
    })
})

test("GET / introduces each tab in one line, dismissible on its own", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()

        assert.deepEqual(
            [...html.matchAll(/<div class="tab-intro" id="intro-[a-z-]+"><span>([^<]+)<\/span>/g)].map(
                (match) => match[1]
            ),
            [
                "Five steps. The highlighted one is where the demo is.",
                "Each organisation on the network, and what it has issued.",
                "Who is admitted, and who is waiting.",
                "The contracts and the account that pays the gas.",
                "Point a phone here to join."
            ]
        )
        assert.equal(html.match(/<button type="button" data-intro="[a-z-]+">Got it<\/button>/g)?.length, 5)
    })
})

test("every flow one-liner stays under twelve words", () => {
    for (const flow of buildDashboardState(inputs()).flows) {
        const words = flow.oneLiner.split(/\s+/).length
        assert.ok(words < 12, `flow ${flow.number} reads ${words} words: ${flow.oneLiner}`)
    }
})

const NO_COUNTS: HintCounts = {
    sponsoredOperations: 0,
    pendingJoinRequests: 0,
    membersAdmitted: 0,
    credentials: 0,
    revocations: 0
}

test("hintCounts reads the five counts a hint can come from, credentials and revocations summed across the orgs", () => {
    assert.deepEqual(hintCounts(buildDashboardState(inputs())), {
        sponsoredOperations: 1,
        pendingJoinRequests: 1,
        membersAdmitted: 1,
        credentials: 0,
        revocations: 1
    })
})

test("hintBetween points at the tab where a count moved, and stays quiet when none did", () => {
    assert.equal(hintBetween(NO_COUNTS, NO_COUNTS), null)
    assert.deepEqual(hintBetween(NO_COUNTS, { ...NO_COUNTS, sponsoredOperations: 1 }), {
        tab: "chain",
        text: "Gas sponsored"
    })
    assert.deepEqual(hintBetween(NO_COUNTS, { ...NO_COUNTS, pendingJoinRequests: 1 }), {
        tab: "network",
        text: "An org asked to join"
    })
    assert.deepEqual(hintBetween(NO_COUNTS, { ...NO_COUNTS, membersAdmitted: 1 }), {
        tab: "network",
        text: "Org admitted"
    })
    assert.deepEqual(hintBetween(NO_COUNTS, { ...NO_COUNTS, credentials: 1 }), {
        tab: "orgs",
        text: "Credential issued"
    })
    assert.deepEqual(hintBetween(NO_COUNTS, { ...NO_COUNTS, revocations: 1 }), {
        tab: "orgs",
        text: "Credential revoked"
    })
})

test("hintBetween ignores a count that fell, and prefers the rarer event when two moved at once", () => {
    const busy = { ...NO_COUNTS, sponsoredOperations: 2, credentials: 2, revocations: 2, membersAdmitted: 2 }

    assert.equal(hintBetween(busy, { ...busy, credentials: 1 }), null)
    assert.deepEqual(hintBetween(busy, { ...busy, membersAdmitted: 3, credentials: 3 }), {
        tab: "network",
        text: "Org admitted"
    })
    assert.deepEqual(hintBetween(busy, { ...busy, revocations: 3, sponsoredOperations: 3 }), {
        tab: "orgs",
        text: "Credential revoked"
    })
})

test("hintBetween picks the rarest event's hint when every count moves at once, pendingJoinRequests included", () => {
    const busier = {
        sponsoredOperations: NO_COUNTS.sponsoredOperations + 1,
        pendingJoinRequests: NO_COUNTS.pendingJoinRequests + 1,
        membersAdmitted: NO_COUNTS.membersAdmitted + 1,
        credentials: NO_COUNTS.credentials + 1,
        revocations: NO_COUNTS.revocations + 1
    }

    assert.deepEqual(hintBetween(NO_COUNTS, busier), { tab: "network", text: "An org asked to join" })
})

test("GET /stack.svg returns a QR code of the dashboard's own stack.json URL", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const response = await fetch(`${base}/stack.svg`)
        assert.equal(response.status, 200)
        assert.match(response.headers.get("content-type") ?? "", /svg/)
        const svg = await response.text()
        assert.match(svg, /<svg/)
    })
})

interface RecordedRequest {
    method: string
    path: string
    body: unknown
}

/** A fake member server that records every request it gets and answers each with `respond`'s
 *  result, the way the real org server's own route would. */
function startFakeProxyMemberServer(respond: (request: RecordedRequest) => { status: number; body: unknown }): Promise<{
    url: string
    close: () => Promise<void>
    requests: RecordedRequest[]
    /** Each request's `authorization` header, parallel to `requests`. */
    authorizations: (string | undefined)[]
}> {
    const requests: RecordedRequest[] = []
    const authorizations: (string | undefined)[] = []
    const server = createServer((request, response) => {
        let raw = ""
        request.on("data", (chunk) => {
            raw += chunk
        })
        request.on("end", () => {
            const recorded: RecordedRequest = {
                method: request.method ?? "",
                path: request.url ?? "",
                body: raw ? JSON.parse(raw) : undefined
            }
            requests.push(recorded)
            authorizations.push(request.headers.authorization)
            const { status, body } = respond(recorded)
            response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
        })
    })
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number }
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((res) => server.close(() => res())),
                requests,
                authorizations
            })
        })
    })
}

async function withProxyDashboard(memberUrl: string, run: (dashboardBase: string) => Promise<void>): Promise<void> {
    const stack: StackDescriptor = { ...STACK, members: [{ ...STACK.members[0], serverUrl: memberUrl }] }
    const dashboard = await startDashboard({
        stack,
        secrets: SECRETS,
        getState: async () => buildDashboardState(inputs({ stack, members: [] })),
        host: "127.0.0.1",
        port: 0
    })
    try {
        await run(dashboard.url)
    } finally {
        await dashboard.close()
    }
}

const KEY = dashboardHeaders(SECRETS)

test("POST /api/orgs/:index/admit forwards the body to the org's admit route and relays status and body", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: { status: "admitted", approvals: 2 } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/admit`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY },
                body: JSON.stringify({ networkId: MEMBER_B_NETWORK_ID })
            })
            assert.equal(res.status, 200)
            assert.deepEqual(await res.json(), { status: "admitted", approvals: 2 })
        })
        assert.deepEqual(member.requests, [
            { method: "POST", path: "/v1/governance/admissions", body: { networkId: MEMBER_B_NETWORK_ID } }
        ])
        // The relay sends the org's own token, never one from the browser.
        assert.deepEqual(member.authorizations, ["Bearer member-token-a"])
    } finally {
        await member.close()
    }
})

test("POST /api/orgs/:index/request-to-join forwards to the org's own route with no body", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 201, body: { txHash: "0xabc" } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/request-to-join`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY }
            })
            assert.equal(res.status, 201)
            assert.deepEqual(await res.json(), { txHash: "0xabc" })
        })
        assert.deepEqual(member.requests, [{ method: "POST", path: "/v1/membership/requests", body: undefined }])
    } finally {
        await member.close()
    }
})

const CREDENTIAL_ID = "urn:uuid:c757d7a2-4859-474c-bbc7-aa274ac6e058"

test("POST /api/orgs/:index/revoke carries credentialId into /v1/credentials/:id/revoke, not the body", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: { id: CREDENTIAL_ID, revoked: true } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/revoke`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY },
                body: JSON.stringify({ credentialId: CREDENTIAL_ID })
            })
            assert.equal(res.status, 200)
            assert.deepEqual(await res.json(), { id: CREDENTIAL_ID, revoked: true })
        })
        assert.deepEqual(member.requests, [
            { method: "POST", path: `/v1/credentials/${encodeURIComponent(CREDENTIAL_ID)}/revoke`, body: undefined }
        ])
    } finally {
        await member.close()
    }
})

// ".." and "." survive encodeURIComponent, so an id the org server never issued has no business
// being built into a path at all.
test("POST /api/orgs/:index/revoke 400s on an id the org server would never have issued", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: { revoked: true } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            for (const credentialId of ["..", ".", "../evil/id", "urn:uuid:not-a-uuid"]) {
                const res = await fetch(`${base}/api/orgs/0/revoke`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...KEY },
                    body: JSON.stringify({ credentialId })
                })
                assert.equal(res.status, 400, `expected 400 for ${credentialId}`)
            }
        })
        assert.deepEqual(member.requests, [])
    } finally {
        await member.close()
    }
})

test("POST /api/orgs/:index/revoke 400s on a missing or empty credentialId, without reaching the org", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: { revoked: true } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const missing = await fetch(`${base}/api/orgs/0/revoke`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY },
                body: JSON.stringify({})
            })
            assert.equal(missing.status, 400)

            const empty = await fetch(`${base}/api/orgs/0/revoke`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY },
                body: JSON.stringify({ credentialId: "" })
            })
            assert.equal(empty.status, 400)
        })
        assert.deepEqual(member.requests, [])
    } finally {
        await member.close()
    }
})

test("GET /api/orgs/:index/credentials relays the org's own listing", async () => {
    const member = await startFakeProxyMemberServer(() => ({
        status: 200,
        body: { credentials: [{ id: "cred-1", programme: "demo-programme", country: "ZZZ", revoked: false }] }
    }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/credentials`, { headers: KEY })
            assert.equal(res.status, 200)
            assert.deepEqual(await res.json(), {
                credentials: [{ id: "cred-1", programme: "demo-programme", country: "ZZZ", revoked: false }]
            })
        })
        assert.deepEqual(member.requests, [{ method: "GET", path: "/v1/credentials", body: undefined }])
    } finally {
        await member.close()
    }
})

test("relays the upstream error status and body, unchanged, for a write action", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 409, body: { error: "already approved" } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/request-to-join`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY }
            })
            assert.equal(res.status, 409)
            assert.deepEqual(await res.json(), { error: "already approved" })
        })
    } finally {
        await member.close()
    }
})

test("GET /api/orgs/:index/credentials answers 500, not a hang or a silent failure, when the upstream is unreachable", async () => {
    await withProxyDashboard("http://127.0.0.1:1", async (base) => {
        const res = await fetch(`${base}/api/orgs/0/credentials`, { headers: KEY })
        assert.equal(res.status, 500)
        assert.ok(((await res.json()) as { error: string }).error)
    })
})

// The dashboard binds to every interface so phones on the LAN can reach it, so an oversized body
// is answered and dropped rather than buffered to whatever the sender feels like sending.
test("answers 413 on a request body past the cap, without reaching the org", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: { status: "admitted" } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/admit`, {
                method: "POST",
                headers: { "content-type": "application/json", ...KEY },
                body: JSON.stringify({ networkId: MEMBER_B_NETWORK_ID, padding: "a".repeat(64 * 1024) })
            })
            assert.equal(res.status, 413)
        })
        assert.deepEqual(member.requests, [])
    } finally {
        await member.close()
    }
})

// A cross-origin form POST needs no preflight, so a hostile page a LAN browser visits could
// otherwise drive admit or revoke. A form cannot send application/json, and the dashboard's own
// click handler always does.
test("answers 415 on a POST that isn't JSON, without reaching the org", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: { status: "admitted" } }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const res = await fetch(`${base}/api/orgs/0/admit`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", ...KEY },
                body: `networkId=${MEMBER_B_NETWORK_ID}`
            })
            assert.equal(res.status, 415)
        })
        assert.deepEqual(member.requests, [])
    } finally {
        await member.close()
    }
})

test("answers 404 for an org index that doesn't exist, on both a write action and the credentials read", async () => {
    await withProxyDashboard("http://127.0.0.1:1", async (base) => {
        const admit = await fetch(`${base}/api/orgs/5/admit`, {
            method: "POST",
            headers: { "content-type": "application/json", ...KEY },
            body: JSON.stringify({ networkId: MEMBER_B_NETWORK_ID })
        })
        assert.equal(admit.status, 404)

        const credentials = await fetch(`${base}/api/orgs/5/credentials`, { headers: KEY })
        assert.equal(credentials.status, 404)
    })
})

async function countGatherer(
    stateTtlMs: number | undefined,
    run: (base: string) => Promise<void>,
    failFirst = false
): Promise<number> {
    let gathers = 0
    const state = buildDashboardState(inputs())
    const dashboard = await startDashboard({
        stack: STACK,
        secrets: SECRETS,
        getState: async () => {
            gathers += 1
            if (failFirst && gathers === 1) throw new Error("rpc down")
            return state
        },
        stateTtlMs,
        host: "127.0.0.1",
        port: 0
    })
    try {
        await run(dashboard.url)
    } finally {
        await dashboard.close()
    }
    return gathers
}

test("a failing gather answers without the provider URL its error carried", async () => {
    const dashboard = await startDashboard({
        stack: STACK,
        secrets: SECRETS,
        getState: async () => {
            throw new Error("HTTP request failed. URL: https://eth-sepolia.example.io/v2/SECRETKEY")
        },
        host: "127.0.0.1",
        port: 0
    })
    try {
        for (const path of ["/api/state", "/"]) {
            const response = await fetch(`${dashboard.url}${path}`)
            assert.equal(response.status, 500, path)
            assert.ok(!(await response.text()).includes("SECRETKEY"), path)
        }
    } finally {
        await dashboard.close()
    }
})

test("startDashboard gathers state on every request by default", async () => {
    const gathers = await countGatherer(undefined, async (base) => {
        await fetch(`${base}/api/state`)
        await fetch(`${base}/api/state`)
    })
    assert.equal(gathers, 2)
})

test("startDashboard shares one gather between requests within stateTtlMs", async () => {
    const gathers = await countGatherer(60_000, async (base) => {
        await Promise.all([fetch(`${base}/api/state`), fetch(`${base}/`)])
        await fetch(`${base}/api/state`)
    })
    assert.equal(gathers, 1)
})

test("startDashboard gathers again once stateTtlMs has passed", async () => {
    const gathers = await countGatherer(20, async (base) => {
        await fetch(`${base}/api/state`)
        await new Promise((resolve) => setTimeout(resolve, 60))
        await fetch(`${base}/api/state`)
    })
    assert.equal(gathers, 2)
})

test("startDashboard does not replay a failed gather to requests within stateTtlMs", async () => {
    const gathers = await countGatherer(
        60_000,
        async (base) => {
            assert.equal((await fetch(`${base}/api/state`)).status, 500)
            assert.equal((await fetch(`${base}/api/state`)).status, 200)
        },
        true
    )
    assert.equal(gathers, 2)
})

test("answers 401, without reaching the org, to any /api/orgs request without the dashboard key", async () => {
    const member = await startFakeProxyMemberServer(() => ({ status: 200, body: {} }))
    try {
        await withProxyDashboard(member.url, async (base) => {
            const wrongKey = `Bearer ${"e".repeat(64)}`
            const wrongLength = `Bearer ${SECRETS.dashboardKey}0`
            const lowercase = `bearer ${SECRETS.dashboardKey}`
            const memberToken = "Bearer member-token-a"
            for (const authorization of [undefined, wrongKey, wrongLength, lowercase, memberToken]) {
                for (const [method, path] of [
                    ["POST", "/api/orgs/0/admit"],
                    ["POST", "/api/orgs/0/revoke"],
                    // 401, not 404, so a caller without the key can't count the orgs.
                    ["POST", "/api/orgs/9/admit"],
                    ["GET", "/api/orgs/0/credentials"]
                ] as const) {
                    const res = await fetch(`${base}${path}`, {
                        method,
                        headers: {
                            ...(method === "POST" ? { "content-type": "application/json" } : {}),
                            ...(authorization ? { authorization } : {})
                        },
                        body: method === "POST" ? "{}" : undefined
                    })
                    assert.equal(res.status, 401, `${method} ${path} with ${authorization ?? "no header"}`)
                    assert.deepEqual(await res.json(), { error: "dashboard key required", code: "UNAUTHORIZED" })
                }
            }
        })
        assert.deepEqual(member.requests, [])
    } finally {
        await member.close()
    }
})

test("checks the dashboard key before the content type, so a keyless text/plain POST is 401, not 415", async () => {
    await withProxyDashboard("http://127.0.0.1:1", async (base) => {
        const res = await fetch(`${base}/api/orgs/0/admit`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}"
        })
        assert.equal(res.status, 401)
    })
})

test("leaves the open routes open: no key needed for the page, the state, the descriptor or its QR", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        for (const path of ["/", "/api/state", "/stack.json", "/stack.svg"]) {
            assert.equal((await fetch(`${base}${path}`)).status, 200, path)
        }
    })
})

test("the page sends the dashboard key it holds, picks it up from #key=, and forgets it on a 401", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /sessionStorage\.getItem\("cn\.dashboardKey"\)/)
        assert.match(html, /location\.hash/)
        assert.match(html, /history\.replaceState/)
        assert.match(html, /authorization: "Bearer " \+ key/)
        assert.match(html, /status === 401\) forgetKey\(\)/)
    })
})

test("the Connect tab sends member apps to the terminal's pairing QR, and the wallet to this one", async () => {
    await withDashboard(buildDashboardState(inputs()), async (base) => {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /Scan this with the wallet/)
        assert.match(html, /pairing QR/)
    })
})
