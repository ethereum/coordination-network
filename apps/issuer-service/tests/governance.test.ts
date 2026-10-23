import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import type { NetworkMemberJoinRequest } from "@coordination-network/network-member-governance"
import { ActivityLog } from "../src/activity"
import { GovernancePorts, GovernanceRevertError } from "../src/governance-ports"
import { GOVERNANCE_ROUTES } from "../src/routes/governance"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"ab".repeat(32)}` as Hex32
const CANDIDATE_ID = `0x${"cd".repeat(32)}` as Hex32
const AUTH_ADDRESS = `0x${"11".repeat(20)}` as const
const GOVERNANCE_SIGNER = `0x${"22".repeat(20)}` as const
const SAFE_ADDRESS = `0x${"33".repeat(20)}` as const
const META_STEALTH_ADDRESS = `0x${"55".repeat(66)}` as const

const FAKE_REQUEST: NetworkMemberJoinRequest = {
    memberNetworkId: CANDIDATE_ID,
    accountKeyX: 1n,
    accountKeyY: 2n,
    semaphoreCommitment: 42n,
    governanceSigner: `0x${"44".repeat(20)}`,
    metadataURI: "https://candidate.example/vetting.json"
}

function fakeGovernancePorts(overrides: Partial<GovernancePorts> = {}): GovernancePorts {
    return {
        networkId: ISSUER_ID,
        authAddress: AUTH_ADDRESS,
        governanceSigner: GOVERNANCE_SIGNER,
        safeAddress: SAFE_ADDRESS,
        metaStealthAddress: META_STEALTH_ADDRESS,
        isApproved: async () => false,
        joinRequestFor: async () => null,
        safeState: async () => ({ owners: [AUTH_ADDRESS], threshold: 1 }),
        identityOf: async () => null,
        issuerKeysOf: async () => [],
        requestToJoin: async () => {
            throw new Error("requestToJoin should not be reached")
        },
        pendingJoinRequests: async () => [],
        admitMember: async () => {
            throw new Error("admitMember should not be reached")
        },
        registerIdentity: async () => {
            throw new Error("registerIdentity should not be reached")
        },
        publishIssuerKey: async () => {
            throw new Error("publishIssuerKey should not be reached")
        },
        ...overrides
    }
}

function fakeResolver(): InMemoryResolver {
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    return resolver
}

async function serve(
    governance: GovernancePorts,
    signer = new LocalCredentialSigner("issuer-service-governance-unit"),
    activityLog?: ActivityLog
) {
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver: fakeResolver(), governance, activityLog })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    return { base: `http://127.0.0.1:${port}`, close: () => listener.close() }
}

test("GET /v1/membership reports none for a member with no request and no approval", async () => {
    const { base, close } = await serve(fakeGovernancePorts())
    try {
        const res = await fetch(`${base}/v1/membership`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {
            networkId: ISSUER_ID,
            authAddress: AUTH_ADDRESS,
            governanceSigner: GOVERNANCE_SIGNER,
            metaStealthAddress: META_STEALTH_ADDRESS,
            status: "none",
            safe: { address: SAFE_ADDRESS, threshold: 1, owners: [AUTH_ADDRESS] },
            identityRegistered: false,
            issuerKeyPublished: false
        })
    } finally {
        close()
    }
})

test("GET /v1/membership reports requested once a join request exists, and approved once isApproved is true", async () => {
    const requested = fakeGovernancePorts({ joinRequestFor: async () => FAKE_REQUEST })
    const { base: requestedBase, close: closeRequested } = await serve(requested)
    try {
        const res = await fetch(`${requestedBase}/v1/membership`)
        assert.equal((await res.json()).status, "requested")
    } finally {
        closeRequested()
    }

    const approved = fakeGovernancePorts({
        isApproved: async () => true,
        identityOf: async () => "0xaa",
        issuerKeysOf: async () => [7n]
    })
    const { base: approvedBase, close: closeApproved } = await serve(approved)
    try {
        const res = await fetch(`${approvedBase}/v1/membership`)
        const body = (await res.json()) as { status: string; identityRegistered: boolean; issuerKeyPublished: boolean }
        assert.equal(body.status, "approved")
        assert.equal(body.identityRegistered, true)
        assert.equal(body.issuerKeyPublished, true)
    } finally {
        closeApproved()
    }
})

test("POST /v1/membership/requests announces the join request and returns its tx hash", async () => {
    const txHash = `0x${"55".repeat(32)}` as const
    const { base, close } = await serve(fakeGovernancePorts({ requestToJoin: async () => txHash }))
    try {
        const res = await fetch(`${base}/v1/membership/requests`, { method: "POST" })
        assert.equal(res.status, 201)
        assert.deepEqual(await res.json(), { txHash })
    } finally {
        close()
    }
})

test("POST /v1/membership/requests 409s when the member is already approved", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            requestToJoin: async () => {
                throw new GovernanceRevertError("AlreadyApproved")
            }
        })
    )
    try {
        const res = await fetch(`${base}/v1/membership/requests`, { method: "POST" })
        assert.equal(res.status, 409)
        assert.deepEqual(await res.json(), { error: "already approved", code: "AlreadyApproved" })
    } finally {
        close()
    }
})

test("GET /v1/governance/requests decodes the pending requests as decimal strings", async () => {
    const { base, close } = await serve(fakeGovernancePorts({ pendingJoinRequests: async () => [FAKE_REQUEST] }))
    try {
        const res = await fetch(`${base}/v1/governance/requests`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {
            requests: [
                {
                    memberNetworkId: FAKE_REQUEST.memberNetworkId,
                    semaphoreCommitment: "42",
                    governanceSigner: FAKE_REQUEST.governanceSigner,
                    metadataURI: FAKE_REQUEST.metadataURI
                }
            ]
        })
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions admits a pending candidate", async () => {
    const outcome = {
        status: "admitted" as const,
        safeTxHash: `0x${"66".repeat(32)}` as const,
        approveTxHash: `0x${"77".repeat(32)}` as const,
        execTxHash: `0x${"88".repeat(32)}` as const,
        approvals: 2,
        threshold: 2
    }
    const { base, close } = await serve(fakeGovernancePorts({ admitMember: async () => outcome }))
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: CANDIDATE_ID })
        })
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {
            status: "admitted",
            safeTxHash: outcome.safeTxHash,
            approveTxHash: outcome.approveTxHash,
            execTxHash: outcome.execTxHash,
            approvals: 2,
            threshold: 2,
            message: "admitted with 2 of 2 approvals"
        })
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions reports the approvals still missing when one org is not a quorum", async () => {
    const outcome = {
        status: "awaitingApprovals" as const,
        safeTxHash: `0x${"66".repeat(32)}` as const,
        approveTxHash: `0x${"77".repeat(32)}` as const,
        approvals: 1,
        threshold: 2
    }
    const activityLog = new ActivityLog()
    const { base, close } = await serve(
        fakeGovernancePorts({ admitMember: async () => outcome }),
        undefined,
        activityLog
    )
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: CANDIDATE_ID })
        })
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {
            status: "awaitingApprovals",
            safeTxHash: outcome.safeTxHash,
            approveTxHash: outcome.approveTxHash,
            approvals: 1,
            threshold: 2,
            message: "waiting for another org: 1 of 2 approvals in"
        })
        assert.match(activityLog.recent()[0].message, /waiting for another org: 1 of 2 approvals in/)
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions reports a null approveTxHash when this org had already approved", async () => {
    const outcome = {
        status: "awaitingApprovals" as const,
        safeTxHash: `0x${"66".repeat(32)}` as const,
        approveTxHash: null,
        approvals: 1,
        threshold: 2
    }
    const { base, close } = await serve(fakeGovernancePorts({ admitMember: async () => outcome }))
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: CANDIDATE_ID })
        })
        const body = (await res.json()) as { approveTxHash: string | null }
        assert.equal(body.approveTxHash, null)
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions 409s when the candidate is already approved", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({ admitMember: async () => ({ status: "alreadyApproved" }) })
    )
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: CANDIDATE_ID })
        })
        assert.equal(res.status, 409)
        assert.deepEqual(await res.json(), { error: "already approved" })
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions 404s when the candidate has no pending request", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({ admitMember: async () => ({ status: "noPendingRequest" }) })
    )
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: CANDIDATE_ID })
        })
        assert.equal(res.status, 404)
        assert.deepEqual(await res.json(), { error: "no pending request" })
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions 500s when the governance port throws mid-admission", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            admitMember: async () => {
                throw new Error("safe transaction reverted")
            }
        })
    )
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: CANDIDATE_ID })
        })
        assert.equal(res.status, 500)
        assert.deepEqual(await res.json(), { error: "internal error" })
    } finally {
        close()
    }
})

test("POST /v1/governance/admissions 400s on a malformed networkId", async () => {
    const { base, close } = await serve(fakeGovernancePorts())
    try {
        const res = await fetch(`${base}/v1/governance/admissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ networkId: "not-a-networkid" })
        })
        assert.equal(res.status, 400)
    } finally {
        close()
    }
})

test("POST /v1/membership/identity 409s when the member isn't approved yet", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            registerIdentity: async () => {
                throw new GovernanceRevertError("NotApproved")
            }
        })
    )
    try {
        const res = await fetch(`${base}/v1/membership/identity`, { method: "POST" })
        assert.equal(res.status, 409)
        assert.deepEqual(await res.json(), { error: "not approved yet", code: "NotApproved" })
    } finally {
        close()
    }
})

test("POST /v1/membership/identity registers this server's own meta-stealth address, taking no body", async () => {
    const txHash = `0x${"99".repeat(32)}` as const
    let calls = 0
    const { base, close } = await serve(
        fakeGovernancePorts({
            registerIdentity: async () => {
                calls += 1
                return txHash
            }
        })
    )
    try {
        const res = await fetch(`${base}/v1/membership/identity`, { method: "POST" })
        assert.equal(res.status, 201)
        assert.deepEqual(await res.json(), { txHash })
        assert.equal(calls, 1)
    } finally {
        close()
    }
})

test("POST /v1/membership/issuer-key publishes this server's own signing key and returns its leaf and root", async () => {
    const signer = new LocalCredentialSigner("issuer-service-governance-issuer-key")
    const [ownX, ownY] = await signer.getPublicKey()
    const txHash = `0x${"bb".repeat(32)}` as const
    let received: [bigint, bigint] | undefined
    const { base, close } = await serve(
        fakeGovernancePorts({
            publishIssuerKey: async (x, y) => {
                received = [x, y]
                return { txHash, leaf: 123n, root: 456n }
            }
        }),
        signer
    )
    try {
        const res = await fetch(`${base}/v1/membership/issuer-key`, { method: "POST" })
        assert.equal(res.status, 201)
        assert.deepEqual(await res.json(), { txHash, leaf: "123", root: "456" })
        assert.deepEqual(received, [ownX, ownY])
    } finally {
        close()
    }
})

test("POST /v1/membership/issuer-key 409s when the key is already published", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            publishIssuerKey: async () => {
                throw new GovernanceRevertError("IssuerKeyAlreadyPublished")
            }
        })
    )
    try {
        const res = await fetch(`${base}/v1/membership/issuer-key`, { method: "POST" })
        assert.equal(res.status, 409)
        assert.deepEqual(await res.json(), {
            error: "issuer key already published",
            code: "IssuerKeyAlreadyPublished"
        })
    } finally {
        close()
    }
})

test("POST /v1/membership/requests 500s on a revert the route doesn't expect", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            requestToJoin: async () => {
                throw new GovernanceRevertError("SomeOtherRevert")
            }
        })
    )
    try {
        const res = await fetch(`${base}/v1/membership/requests`, { method: "POST" })
        assert.equal(res.status, 500)
    } finally {
        close()
    }
})

const GOVERNANCE_ROUTE_METHODS: Record<keyof typeof GOVERNANCE_ROUTES, "GET" | "POST"> = {
    membership: "GET",
    requestToJoin: "POST",
    pendingRequests: "GET",
    admit: "POST",
    registerIdentity: "POST",
    publishIssuerKey: "POST"
}

test("every GOVERNANCE_ROUTES path is mounted, answering something other than 404 on a running server", async () => {
    const { base, close } = await serve(fakeGovernancePorts())
    try {
        for (const [key, path] of Object.entries(GOVERNANCE_ROUTES) as [keyof typeof GOVERNANCE_ROUTES, string][]) {
            const res = await fetch(`${base}${path}`, { method: GOVERNANCE_ROUTE_METHODS[key] })
            assert.notEqual(res.status, 404, `${GOVERNANCE_ROUTE_METHODS[key]} ${path} answered 404`)
        }
    } finally {
        close()
    }
})

test("every GOVERNANCE_ROUTES value starts with /v1/, matching the rest of the API", () => {
    for (const path of Object.values(GOVERNANCE_ROUTES)) {
        assert.match(path, /^\/v1\//)
    }
})

test("governance routes are not mounted when the server has no governance ports", async () => {
    const signer = new LocalCredentialSigner("issuer-service-governance-absent")
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver: fakeResolver() })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/membership`)
        assert.equal(res.status, 404)
    } finally {
        listener.close()
    }
})
