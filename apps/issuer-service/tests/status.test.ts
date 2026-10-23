import assert from "node:assert/strict"
import { test } from "node:test"
import { ApprovedIssuerSet, Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import type { NetworkMemberJoinRequest } from "@coordination-network/network-member-governance"
import { ActivityLog } from "../src/activity"
import { GovernancePorts } from "../src/governance-ports"
import { IssuerSetBacking } from "../src/issuer-set"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"ab".repeat(32)}` as Hex32
const AUTH_ADDRESS = `0x${"11".repeat(20)}` as const
const GOVERNANCE_SIGNER = `0x${"22".repeat(20)}` as const
const SAFE_ADDRESS = `0x${"33".repeat(20)}` as const
const CANDIDATE_ID = `0x${"cd".repeat(32)}` as Hex32

const PENDING_REQUEST: NetworkMemberJoinRequest = {
    memberNetworkId: CANDIDATE_ID,
    accountKeyX: 1n,
    accountKeyY: 2n,
    semaphoreCommitment: 7n,
    governanceSigner: `0x${"66".repeat(20)}`,
    metadataURI: "https://candidate.example/vetting.json"
}

function fakeGovernancePorts(overrides: Partial<GovernancePorts> = {}): GovernancePorts {
    return {
        networkId: ISSUER_ID,
        authAddress: AUTH_ADDRESS,
        governanceSigner: GOVERNANCE_SIGNER,
        safeAddress: SAFE_ADDRESS,
        metaStealthAddress: `0x${"55".repeat(66)}`,
        isApproved: async () => true,
        joinRequestFor: async () => null,
        safeState: async () => ({ owners: [AUTH_ADDRESS], threshold: 1 }),
        identityOf: async () => "0xaa",
        issuerKeysOf: async () => [],
        requestToJoin: async () => {
            throw new Error("not reached")
        },
        pendingJoinRequests: async () => [],
        admitMember: async () => {
            throw new Error("not reached")
        },
        registerIdentity: async () => {
            throw new Error("not reached")
        },
        publishIssuerKey: async () => {
            throw new Error("not reached")
        },
        ...overrides
    }
}

/** The page's server-rendered markup, the inline script excluded: the script's own source text
 *  carries a copy of nearly every label, button, and attribute the client can produce, so a
 *  substring check against the full page would pass regardless of what was actually rendered. */
function renderedPanels(html: string): string {
    return html.split("<script>")[0]
}

function scriptSource(html: string): string {
    return html.split("<script>")[1]
}

/** One panel's own body markup, isolated from its neighbours, so a badge or a `<details>` fold
 *  can be asserted against the right panel rather than the page as a whole. */
function panelBody(html: string, id: string): string {
    const match = html.match(new RegExp(`id="panel-body-${id}">(.*?)</div></section>`, "s"))
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

function fakeIssuerSet(leaves: bigint[] = [], root = 0n, size = leaves.length): IssuerSetBacking {
    return {
        address: `0x${"44".repeat(20)}`,
        read: async () => ({ leaves, root, blockNumber: 1n, size }),
        isValidRoot: async () => true
    }
}

async function serve(
    governance: GovernancePorts,
    issuerSet: IssuerSetBacking,
    activityLog = new ActivityLog(),
    accent?: string
) {
    const signer = new LocalCredentialSigner("issuer-service-status-unit")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        governance,
        issuerSet,
        activityLog,
        displayName: "Org 1",
        dashboardUrl: "http://dashboard.example",
        accent
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    return { base: `http://127.0.0.1:${port}`, close: () => listener.close(), signer }
}

test("GET /v1/status reports the shape the spec names", async () => {
    const { base, close, signer } = await serve(fakeGovernancePorts(), fakeIssuerSet([1n, 2n]))
    try {
        const res = await fetch(`${base}/v1/status`)
        assert.equal(res.status, 200)
        const body = (await res.json()) as Record<string, unknown>

        assert.equal(body.networkId, ISSUER_ID)
        assert.equal(body.displayName, "Org 1")
        assert.equal(body.authAddress, AUTH_ADDRESS)
        assert.deepEqual(body.membership, {
            status: "approved",
            safe: { address: SAFE_ADDRESS, threshold: 1, owners: [AUTH_ADDRESS] },
            identityRegistered: true,
            issuerKeyPublished: false
        })
        const [x, y] = await signer.getPublicKey()
        assert.deepEqual(body.issuerKey, { x: x.toString(), y: y.toString(), published: false })
        assert.deepEqual(body.issuerSet, { address: `0x${"44".repeat(20)}`, root: "0", size: 2 })
        assert.deepEqual(body.counts, {
            registrations: 0,
            existingRegistrations: 0,
            credentials: 0,
            revocations: 0,
            verifications: 0,
            rejectedVerifications: 0
        })
    } finally {
        close()
    }
})

test("GET /v1/status reports issuerSet.size from the backing's own size, not the physical leaf count", async () => {
    // getLeafCount() counts every physical slot, retired ones included; getSize() counts only live
    // keys. A set with one retired slot has leaves.length 3 but a size of 2.
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet([1n, 2n, 0n], 0n, 2))
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { issuerSet: { size: number } }
        assert.equal(body.issuerSet.size, 2)
    } finally {
        close()
    }
})

test("GET /v1/status counts recent activity by kind", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("registration", "registered a", undefined, "ok")
    activityLog.append("registration", "registered b", undefined, "ok")
    activityLog.append("credential", "issued one", undefined, "ok")
    activityLog.append("verification", "verified one", undefined, "ok")
    activityLog.append("verification", "verification rejected: REVOKED", undefined, "failed")
    activityLog.append("governance", "admitted one")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { counts: Record<string, number> }
        assert.deepEqual(body.counts, {
            registrations: 2,
            existingRegistrations: 0,
            credentials: 1,
            revocations: 0,
            verifications: 1,
            rejectedVerifications: 1
        })
    } finally {
        close()
    }
})

test("GET /v1/status counts existing and failed registrations apart from successful ones", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("registration", "registered a", undefined, "ok")
    activityLog.append("registration", "found an existing registration", undefined, "existing")
    activityLog.append("registration", "registration failed: REGISTRY_UNAVAILABLE", undefined, "failed")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { counts: Record<string, number> }
        assert.equal(body.counts.registrations, 1)
        assert.equal(body.counts.existingRegistrations, 1)
    } finally {
        close()
    }
})

test("GET /v1/status carries the last five activity entries, newest first and without refs", async () => {
    const activityLog = new ActivityLog()
    for (const n of [1, 2, 3, 4, 5, 6]) {
        activityLog.append("credential", `issued ${n}`, { credentialId: `0x${n}` })
    }

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { recentActivity: { kind: string; message: string; at: number }[] }
        assert.deepEqual(
            body.recentActivity.map((entry) => entry.message),
            ["issued 6", "issued 5", "issued 4", "issued 3", "issued 2"]
        )
        for (const entry of body.recentActivity) {
            assert.deepEqual(Object.keys(entry).sort(), ["at", "kind", "message"])
        }
    } finally {
        close()
    }
})

test("GET /v1/status carries every entry, unpadded, when the log holds fewer than five", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("credential", "issued 1")
    activityLog.append("credential", "issued 2")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { recentActivity: { message: string }[] }
        assert.deepEqual(
            body.recentActivity.map((entry) => entry.message),
            ["issued 2", "issued 1"]
        )
    } finally {
        close()
    }
})

test("GET /v1/status carries an empty recentActivity when the log holds nothing", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), new ActivityLog())
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { recentActivity: unknown[] }
        assert.deepEqual(body.recentActivity, [])
    } finally {
        close()
    }
})

test("GET /v1/status counts neither a registration, a credential, nor a verification entry whose outcome is unset", async () => {
    // Only registration, credential, and verification entries carry an outcome at all; an entry
    // of any of those kinds logged without one (as every other kind always is) falls outside
    // every outcome-keyed count.
    const activityLog = new ActivityLog()
    activityLog.append("registration", "registered a network id")
    activityLog.append("credential", "issued a credential")
    activityLog.append("verification", "verified a presentation")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { counts: Record<string, number> }
        assert.deepEqual(body.counts, {
            registrations: 0,
            existingRegistrations: 0,
            credentials: 0,
            revocations: 0,
            verifications: 0,
            rejectedVerifications: 0
        })
    } finally {
        close()
    }
})

test("GET /v1/status counts only a successful credential issuance, not a rejected or failed one", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("credential", "issued a credential", undefined, "ok")
    activityLog.append("credential", "issuance rejected: ISSUER_NOT_APPROVED", undefined, "failed")
    activityLog.append("credential", "issuance failed", undefined, "failed")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { counts: Record<string, number> }
        assert.equal(body.counts.credentials, 1)
    } finally {
        close()
    }
})

test("GET /v1/status counts a verification whose outcome is 'existing' (a registration-only value) toward neither verifications nor rejectedVerifications", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("verification", "verified a presentation", undefined, "existing")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/status`)
        const body = (await res.json()) as { counts: Record<string, number> }
        assert.equal(body.counts.verifications, 0)
        assert.equal(body.counts.rejectedVerifications, 0)
    } finally {
        close()
    }
})

test("GET /v1/status reports issuerKey.published true, and the badge as published, when the signer's own leaf is in the set", async () => {
    const signer = new LocalCredentialSigner("issuer-service-status-unit")
    const ownLeaf = ApprovedIssuerSet.leafOf(await signer.getPublicKey())

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet([ownLeaf]))
    try {
        const statusBody = (await (await fetch(`${base}/v1/status`)).json()) as { issuerKey: { published: boolean } }
        assert.equal(statusBody.issuerKey.published, true)

        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /badge-success">published<\/span>/)
    } finally {
        close()
    }
})

test("GET / sets --accent from ServerDeps.accent when the server was built with one", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), new ActivityLog(), "#1d4ed8")
    try {
        const html = await (await fetch(`${base}/`)).text()
        assert.match(html, /<body style="--accent: #1d4ed8">/)
    } finally {
        close()
    }
})

test("GET /v1/activity returns the log's recent entries, newest first", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("credential", "first")
    activityLog.append("credential", "second")

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/v1/activity`)
        assert.equal(res.status, 200)
        const body = (await res.json()) as { entries: { message: string }[] }
        assert.deepEqual(
            body.entries.map((entry) => entry.message),
            ["second", "first"]
        )
    } finally {
        close()
    }
})

test("GET / renders the status page as HTML, with the dashboard link included", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const res = await fetch(`${base}/`)
        assert.equal(res.status, 200)
        assert.match(res.headers.get("content-type") ?? "", /html/)
        const html = await res.text()
        assert.match(html, /Org 1/)
        assert.match(html, /http:\/\/dashboard\.example/)
        assert.match(html, /Registrations/)
        assert.doesNotMatch(html, /Sponsored registrations/)
    } finally {
        close()
    }
})

test("GET / leads the identity and issuer panels with their badge, folding their raw values behind a closed <details>", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet([1n, 2n]))
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())

        const identity = panelBody(html, "identity")
        assert.match(
            identity,
            /^<span class="badge badge-success">approved<\/span><details><summary>Details<\/summary>/
        )
        assert.match(identity, new RegExp(`<details>.*${ISSUER_ID}.*</details>`, "s"))

        const issuer = panelBody(html, "issuer")
        assert.match(
            issuer,
            /^<span class="badge badge-warning">not published<\/span><details><summary>Details<\/summary>/
        )

        assert.match(panelBody(html, "registrations"), /^<details><summary>Details<\/summary>/)

        // The links panel stays open: a presenter clicks these rather than reading them.
        const links = panelBody(html, "links")
        assert.doesNotMatch(links, /<details>/)
        assert.match(links, /http:\/\/dashboard\.example/)
    } finally {
        close()
    }
})

test("GET / keeps the Membership panel's actions and pending requests open, folding only the Safe's own threshold and owners", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        const membership = panelBody(html, "membership")

        const detailsIndex = membership.indexOf("<details>")
        assert.ok(detailsIndex > 0)
        assert.ok(membership.indexOf('data-action="publish-issuer-key"') < detailsIndex)
        assert.ok(membership.indexOf("Pending requests") < detailsIndex)
        assert.match(membership, /<details><summary>Safe details<\/summary>/)

        // The caveat the panel used to print as a line of its own now folds under the tab's intro.
        assert.doesNotMatch(membership, /These actions carry no authentication/)
        assert.match(
            html,
            /<details><summary>Good to know<\/summary>Each button sends this org&#39;s member server token\. The page asks for it on the first click and keeps it for this tab; a 401 clears it and asks again\.<\/details>/
        )
    } finally {
        close()
    }
})

test("GET / keeps the recent-activity feed open, with no <details> fold", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        const activity = panelBody(html, "activity")
        assert.match(activity, /^<p class="empty">None yet\.<\/p>$/)
    } finally {
        close()
    }
})

test("GET / splits the panels across Actions, Activity and Details, each panel id where the poll looks for it", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())

        assert.deepEqual(
            [...html.matchAll(/<button type="button" role="tab" id="tab-([a-z]+)"[^>]*>([^<]+)<\/button>/g)].map(
                (match) => [match[1], match[2]]
            ),
            [
                ["actions", "Actions"],
                ["activity", "Activity"],
                ["details", "Details"]
            ]
        )
        assert.equal(html.match(/<section role="tabpanel"[^>]*hidden>/g)?.length, 3)
        assert.deepEqual(
            {
                actions: [...tabSection(html, "actions").matchAll(/id="panel-body-([a-z-]+)"/g)].map(
                    (match) => match[1]
                ),
                activity: [...tabSection(html, "activity").matchAll(/id="panel-body-([a-z-]+)"/g)].map(
                    (match) => match[1]
                ),
                details: [...tabSection(html, "details").matchAll(/id="panel-body-([a-z-]+)"/g)].map(
                    (match) => match[1]
                )
            },
            {
                actions: ["membership"],
                activity: ["activity", "registrations"],
                details: ["identity", "issuer", "links"]
            }
        )
        assert.deepEqual(
            [...html.matchAll(/<div class="tab-intro" id="intro-[a-z]+"><span>([^<]+)<\/span>/g)].map(
                (match) => match[1]
            ),
            ["What this org can do right now.", "What it has done.", "Its keys and addresses."]
        )
    } finally {
        close()
    }
})

test("GET / leaves the links tab out of Details when the server knows of no other page", async () => {
    const signer = new LocalCredentialSigner("issuer-service-status-no-links")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        governance: fakeGovernancePorts(),
        issuerSet: fakeIssuerSet(),
        displayName: "Org 1"
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        const html = renderedPanels(await (await fetch(`http://127.0.0.1:${port}/`)).text())
        assert.deepEqual(
            [...tabSection(html, "details").matchAll(/id="panel-body-([a-z-]+)"/g)].map((match) => match[1]),
            ["identity", "issuer"]
        )
    } finally {
        listener.close()
    }
})

test("GET / drops an activity entry's refs from its rendered line, so the message reads as a sentence on its own", async () => {
    const activityLog = new ActivityLog()
    activityLog.append("governance", "registered its member identity", { txHash: "0xdeadbeef" })

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        assert.match(html, /registered its member identity/)
        assert.doesNotMatch(html, /0xdeadbeef/)
        assert.doesNotMatch(html, /txHash/)
    } finally {
        close()
    }
})

test("GET / links every other org's status page by that org's own name, never 'Other member'", async () => {
    const signer = new LocalCredentialSigner("issuer-service-status-peer")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        governance: fakeGovernancePorts(),
        issuerSet: fakeIssuerSet(),
        displayName: "Org 1",
        peers: [
            { name: "Org 2", url: "http://org-2.example" },
            { name: "Org 3", url: "http://org-3.example" }
        ]
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        const html = renderedPanels(await (await fetch(`http://127.0.0.1:${port}/`)).text())
        assert.match(html, /Org 2/)
        assert.match(html, /http:\/\/org-2\.example/)
        assert.match(html, /Org 3/)
        assert.match(html, /http:\/\/org-3\.example/)
        assert.doesNotMatch(html, /Other member/)
    } finally {
        listener.close()
    }
})

test("GET / escapes attacker-controlled activity text (e.g. a candidate's metadataURI) instead of inlining it", async () => {
    const activityLog = new ActivityLog()
    const payload = "<script>alert(document.cookie)</script>"
    activityLog.append("governance", `candidate metadata: ${payload}`, { metadataURI: payload })

    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet(), activityLog)
    try {
        const res = await fetch(`${base}/`)
        const html = await res.text()
        assert.doesNotMatch(html, /<script>alert\(document\.cookie\)<\/script>/)
        assert.match(html, /&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/)
    } finally {
        close()
    }
})

test("GET / offers only a request-to-join button when membership is none", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({ isApproved: async () => false, joinRequestFor: async () => null }),
        fakeIssuerSet()
    )
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        assert.match(html, /data-action="request-to-join"/)
        assert.doesNotMatch(html, /data-action="register-identity"/)
        assert.doesNotMatch(html, /data-action="publish-issuer-key"/)
        assert.doesNotMatch(html, /data-action="admit"/)
        assert.doesNotMatch(html, /Pending requests/)
    } finally {
        close()
    }
})

test("GET / shows a waiting line and no action buttons while membership is requested", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({ isApproved: async () => false, joinRequestFor: async () => PENDING_REQUEST }),
        fakeIssuerSet()
    )
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        assert.match(html, /Waiting for the network's governance Safe to admit it\./)
        assert.doesNotMatch(html, /data-action=/)
    } finally {
        close()
    }
})

test("GET / offers register-identity and publish-issuer-key, and lists a pending request with an admit button, once approved", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            isApproved: async () => true,
            identityOf: async () => null,
            issuerKeysOf: async () => [],
            pendingJoinRequests: async () => [PENDING_REQUEST]
        }),
        fakeIssuerSet()
    )
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        assert.match(html, /data-action="register-identity"/)
        assert.match(html, /data-action="publish-issuer-key"/)
        assert.match(html, new RegExp(`data-action="admit" data-network-id="${CANDIDATE_ID}"`))
        assert.match(html, /vetting\.json/)
    } finally {
        close()
    }
})

test("GET / offers no action buttons once identity and issuer key are both done and no one is waiting", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            isApproved: async () => true,
            identityOf: async () => "0xaa",
            issuerKeysOf: async () => [1n],
            pendingJoinRequests: async () => []
        }),
        fakeIssuerSet()
    )
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        assert.doesNotMatch(html, /data-action=/)
        assert.match(html, /None yet\./)
    } finally {
        close()
    }
})

test("GET / ships a script that guards governance buttons against a second submit while one is in flight", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const script = scriptSource(await (await fetch(`${base}/`)).text())
        // Every rendered action button carries this conditional, so a poll landing mid-request
        // still renders them disabled.
        assert.match(script, /\(inFlight \? " disabled" : ""\)/)
        // The click handler itself refuses a second click while one is already in flight.
        assert.match(script, /if \(!button \|\| inFlight\) return;/)
        // The handler also disables the live buttons at once, rather than waiting on the next
        // render to catch up.
        assert.match(
            script,
            /document\.querySelectorAll\("\[data-action\]"\)\.forEach\(function \(b\) \{ b\.disabled = true; \}\);/
        )
    } finally {
        close()
    }
})

test("GET / ships a script that asks for the member server token rather than inlining one", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const script = scriptSource(await (await fetch(`${base}/`)).text())
        assert.match(script, /prompt\("Member server token/)
        assert.match(script, /sessionStorage\.getItem\("cn\.memberServerToken"\)/)
        assert.match(script, /headers\["authorization"\] = "Bearer " \+ token;/)
        assert.match(script, /if \(res\.status === 401\) forgetToken\(\);/)
        assert.doesNotMatch(script, /MEMBER_SERVER_TOKEN =/)
    } finally {
        close()
    }
})

test("GET / ships a script that renders the Membership panel from the /v1/status poll, not its own GET /v1/membership or GET /v1/governance/requests fetches", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const script = scriptSource(await (await fetch(`${base}/`)).text())
        assert.doesNotMatch(script, /\/v1\/membership"/)
        assert.doesNotMatch(script, /\/v1\/governance\/requests"/)
        assert.match(script, /renderMembership\(status\.membership, status\.pendingRequests, status\.displayName\)/)
    } finally {
        close()
    }
})

test("GET / ships a script whose setBody preserves a panel's <details> open state across the poll", async () => {
    const { base, close } = await serve(fakeGovernancePorts(), fakeIssuerSet())
    try {
        const script = scriptSource(await (await fetch(`${base}/`)).text())
        assert.match(script, /var wasOpen = !!el\.querySelector\("details"\) && el\.querySelector\("details"\)\.open;/)
        assert.match(script, /if \(details && wasOpen\) details\.open = true;/)
    } finally {
        close()
    }
})

test("GET / lists the same candidate twice, each with its own admit button, when it appears twice in pendingJoinRequests", async () => {
    const { base, close } = await serve(
        fakeGovernancePorts({
            isApproved: async () => true,
            pendingJoinRequests: async () => [PENDING_REQUEST, PENDING_REQUEST]
        }),
        fakeIssuerSet()
    )
    try {
        const html = renderedPanels(await (await fetch(`${base}/`)).text())
        const admitButtons = html.match(new RegExp(`data-action="admit" data-network-id="${CANDIDATE_ID}"`, "g"))
        assert.equal(admitButtons?.length, 2)
    } finally {
        close()
    }
})

test("GET / escapes a hostile pending request's networkId and metadataURI", async () => {
    const payload = "<script>alert(document.cookie)</script>"
    const hostileRequest: NetworkMemberJoinRequest = {
        memberNetworkId: `0x${"ef".repeat(32)}` as Hex32,
        accountKeyX: 1n,
        accountKeyY: 2n,
        semaphoreCommitment: 1n,
        governanceSigner: `0x${"77".repeat(20)}`,
        metadataURI: payload
    }
    const { base, close } = await serve(
        fakeGovernancePorts({ isApproved: async () => true, pendingJoinRequests: async () => [hostileRequest] }),
        fakeIssuerSet()
    )
    try {
        const html = await (await fetch(`${base}/`)).text()
        assert.doesNotMatch(html, /<script>alert\(document\.cookie\)<\/script>/)
        assert.match(html, /&lt;script&gt;alert\(document\.cookie\)&lt;\/script&gt;/)
    } finally {
        close()
    }
})

test("status routes are not mounted when the server has no governance ports", async () => {
    const signer = new LocalCredentialSigner("issuer-service-status-absent")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/status`)
        assert.equal(res.status, 404)
    } finally {
        listener.close()
    }
})
