import type { Address } from "viem"
import type { Hex32 } from "@coordination-network/credential"
import type { ActivityEntry } from "../activity"
import { GOVERNANCE_ROUTES } from "../routes/governance"
import {
    Panel,
    Tab,
    actionButton,
    badge,
    details,
    escapeHtml,
    keyValueTable,
    list,
    renderPage,
    tabsScript
} from "./template"

export interface MembershipSnapshot {
    status: "approved" | "requested" | "none"
    safe: { address: Address; threshold: number; owners: Address[] }
    identityRegistered: boolean
    issuerKeyPublished: boolean
}

/** The fields the Membership panel's "Pending requests" list needs from a join request; see
 *  `GET /v1/governance/requests` for the request's full shape. */
export interface PendingJoinRequest {
    memberNetworkId: string
    metadataURI: string
}

/** Another org on the same network, as the links panel names it. */
export interface PeerOrg {
    name: string
    url: string
}

export interface StatusPageData {
    networkId: Hex32
    displayName: string
    authAddress: Address
    membership: MembershipSnapshot
    /** Every unapproved join request, when `membership.status` is `"approved"`; `[]` otherwise,
     *  since only an approved org can admit one. */
    pendingRequests: PendingJoinRequest[]
    issuerKey: { x: string; y: string; published: boolean }
    issuerSet: { address: Address | null; root: string; size: number }
    counts: {
        registrations: number
        /** Registrations that resolved to a record this network already held. */
        existingRegistrations: number
        credentials: number
        revocations: number
        verifications: number
        /** Presentations this org checked and turned down. */
        rejectedVerifications: number
    }
    activity: ActivityEntry[]
    /** The stack dashboard's own URL, when this server was started from one. */
    dashboardUrl?: string
    /** The other orgs' status pages, when this server knows about them. */
    peers?: PeerOrg[]
    /** This org's brand accent, when the server was started with one. */
    accent?: string
}

const MEMBERSHIP_TONE = { approved: "success", requested: "warning", none: "default" } as const

/** The membership badge stays above the fold: it is the one thing on this panel a reader takes in
 *  at a glance, now that the tab's own intro has replaced the panel's caption. */
function identityPanel(data: StatusPageData): Panel {
    const { membership } = data
    const raw =
        keyValueTable([
            ["Network ID", data.networkId],
            ["Display name", data.displayName],
            ["Auth address", data.authAddress],
            ["Safe address", membership.safe.address],
            ["Safe threshold", String(membership.safe.threshold)],
            ["Identity registered", membership.identityRegistered ? "yes" : "no"]
        ]) +
        `<p class="kv-label" style="margin:12px 0 4px">Safe owners</p>` +
        list(membership.safe.owners)
    const body = badge(membership.status, MEMBERSHIP_TONE[membership.status]) + details("Details", raw)
    return { id: "identity", title: "Identity and membership", body }
}

/** The action buttons this org can take from where it stands: join the network, then, once
 *  approved, register its identity and publish its issuer key. Empty once both are done. */
function membershipButtons(membership: MembershipSnapshot): string {
    if (membership.status === "none") return actionButton("Request to join", "request-to-join")
    if (membership.status !== "approved") return ""
    return (
        (membership.identityRegistered ? "" : actionButton("Register identity", "register-identity")) +
        (membership.issuerKeyPublished ? "" : actionButton("Publish issuer key", "publish-issuer-key"))
    )
}

function pendingRequestItem(request: PendingJoinRequest): string {
    const label = request.metadataURI ? `${request.memberNetworkId} — ${request.metadataURI}` : request.memberNetworkId
    const admit = actionButton("Admit", "admit", { "network-id": request.memberNetworkId })
    return `<li>${escapeHtml(label)} ${admit}</li>`
}

/** This org's own governance actions: request to join, then, once approved, register its
 *  identity, publish its issuer key, and admit whoever else is waiting. Mirrored by the page
 *  script's own `renderMembership` (see {@link pollingScript}), which renders from the same
 *  `membership`/`pendingRequests` fields the `GET /v1/status` poll already fetched. The buttons,
 *  pending requests, and outcome line stay open, not folded: they're what a presenter points at. */
function membershipPanel(data: StatusPageData): Panel {
    const { membership, pendingRequests } = data
    const parts: string[] = []

    if (membership.status === "requested") {
        parts.push(`<p>Waiting for the network's governance Safe to admit it.</p>`)
    }

    const buttons = membershipButtons(membership)
    if (buttons) parts.push(`<p class="actions">${buttons}</p>`)

    if (membership.status === "approved") {
        parts.push(`<p class="kv-label" style="margin:12px 0 4px">Pending requests</p>`)
        parts.push(
            pendingRequests.length === 0
                ? `<p class="empty">None yet.</p>`
                : `<ul class="plain">${pendingRequests.map(pendingRequestItem).join("")}</ul>`
        )
    }

    const safeRaw =
        keyValueTable([["Safe threshold", String(membership.safe.threshold)]]) +
        `<p class="kv-label" style="margin:12px 0 4px">Safe owners</p>` +
        list(membership.safe.owners)
    parts.push(details("Safe details", safeRaw))

    return { id: "membership", title: "Membership", body: parts.join("") }
}

function issuerPanel(data: StatusPageData): Panel {
    const { issuerKey, issuerSet } = data
    const raw = keyValueTable([
        ["Public key x", issuerKey.x],
        ["Public key y", issuerKey.y],
        ["Approved-issuer set", issuerSet.address ?? "in-memory"],
        ["Root", issuerSet.root],
        ["Size", String(issuerSet.size)]
    ])
    const body =
        badge(issuerKey.published ? "published" : "not published", issuerKey.published ? "success" : "warning") +
        details("Details", raw)
    return { id: "issuer", title: "Issuer key and set", body }
}

/** Renders one activity entry as a single line, its refs left out so the message reads as a
 *  sentence on its own; every entry's message already names what it needs to (see e.g.
 *  `registrations.ts`'s "found an existing registration" or `governance.ts`'s "admitted
 *  <networkId> to the network"). Used by the registrations and recent-activity panels alike. */
function formatEntry(entry: ActivityEntry): string {
    const when = new Date(entry.at).toLocaleTimeString()
    return `${when} — ${entry.message}`
}

/** Registrations fold: they're a kind-filtered slice of the same feed the recent-activity panel
 *  already shows open. */
function registrationsPanel(data: StatusPageData): Panel {
    const entries = data.activity.filter((entry) => entry.kind === "registration")
    return { id: "registrations", title: "Registrations", body: details("Details", list(entries.map(formatEntry))) }
}

/** Stays open, unlike every other panel here: it's what a presenter points at. */
function activityPanel(data: StatusPageData): Panel {
    return { id: "activity", title: "Recent activity", body: list(data.activity.slice(0, 20).map(formatEntry)) }
}

function linksPanel(data: StatusPageData): Panel | undefined {
    const rows: [string, string][] = []
    if (data.dashboardUrl) rows.push(["Dashboard", data.dashboardUrl])
    // Named per org rather than "Other org": on a network of three there is more than one.
    for (const peer of data.peers ?? []) rows.push([peer.name, peer.url])
    if (rows.length === 0) return undefined
    // Not folded: a presenter clicks these, so they are navigation, not detail.
    return { id: "links", title: "Links", body: keyValueTable(rows) }
}

/** The vanilla script the page ships: polls the status, activity, and membership endpoints every
 *  2s and rewrites each panel's body in place; wires up the Membership panel's own action
 *  buttons. Kept a plain function so the panel HTML it produces matches this module's own render
 *  functions above, just re-expressed for a browser with no bundler and no access to this file's
 *  TypeScript. A folded panel's open/closed state is read off the DOM before its body is replaced
 *  and restored after, so a presenter's click survives the poll. */
function pollingScript(): string {
    // Read lazily, not at module scope: this module and routes/governance.ts import each other
    // (page.ts -> governance.ts -> routes/status.ts -> page.ts), and GOVERNANCE_ROUTES isn't
    // assigned yet the first time this file itself finishes loading.
    const actionPaths = {
        "request-to-join": GOVERNANCE_ROUTES.requestToJoin,
        "register-identity": GOVERNANCE_ROUTES.registerIdentity,
        "publish-issuer-key": GOVERNANCE_ROUTES.publishIssuerKey,
        admit: GOVERNANCE_ROUTES.admit
    }
    return `
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
function fmt(e) { var when = new Date(e.at).toLocaleTimeString(); return "<li>" + esc(when + " — " + e.message) + "</li>"; }
function listHtml(items) { return items.length ? "<ul class=\\"plain\\">" + items.join("") + "</ul>" : "<p class=\\"empty\\">None yet.</p>"; }
function detailsHtml(summary, body) { return "<details><summary>" + esc(summary) + "</summary>" + body + "</details>"; }
function setBody(id, html) {
    var el = document.getElementById("panel-body-" + id);
    if (!el) return;
    var wasOpen = !!el.querySelector("details") && el.querySelector("details").open;
    el.innerHTML = html;
    var details = el.querySelector("details");
    if (details && wasOpen) details.open = true;
}
function badgeHtml(label, tone) { return "<span class=\\"badge badge-" + tone + "\\">" + esc(label) + "</span>"; }
var ACTION_PATHS = ${JSON.stringify(actionPaths)};
// The governance routes want the member server token, which the page never carries: a button
// asks for it on the first click and keeps it for this tab. The two polls are open routes.
function heldToken() { try { return sessionStorage.getItem("cn.memberServerToken") || ""; } catch (err) { return ""; } }
function forgetToken() { try { sessionStorage.removeItem("cn.memberServerToken"); } catch (err) { /* nothing held */ } }
function askToken() {
    var value = (window.prompt("Member server token for this org (MEMBER_SERVER_TOKEN)") || "").trim();
    if (value) { try { sessionStorage.setItem("cn.memberServerToken", value); } catch (err) { /* asked again next click */ } }
    return value;
}
var membershipOutcome = "";
// Set for the duration of a governance POST, so a poll landing mid-request re-renders the
// buttons disabled too, not just the ones the click handler touched directly.
var inFlight = false;
function actionButtonHtml(label, action, dataAttrs) {
    var attrs = "";
    for (var key in dataAttrs) { attrs += " data-" + key + "=\\"" + esc(dataAttrs[key]) + "\\""; }
    return "<button type=\\"button\\" data-action=\\"" + esc(action) + "\\"" + attrs + (inFlight ? " disabled" : "") + ">" + esc(label) + "</button>";
}
function membershipButtonsHtml(m) {
    if (m.status === "none") return actionButtonHtml("Request to join", "request-to-join", {});
    if (m.status !== "approved") return "";
    return (m.identityRegistered ? "" : actionButtonHtml("Register identity", "register-identity", {})) +
        (m.issuerKeyPublished ? "" : actionButtonHtml("Publish issuer key", "publish-issuer-key", {}));
}
function pendingRequestHtml(r) {
    var label = r.metadataURI ? r.memberNetworkId + " — " + r.metadataURI : r.memberNetworkId;
    return "<li>" + esc(label) + " " + actionButtonHtml("Admit", "admit", { "network-id": r.memberNetworkId }) + "</li>";
}
function renderMembership(m, pending, displayName) {
    var html = "";
    if (m.status === "requested") html += "<p>Waiting for the network's governance Safe to admit it.</p>";
    var buttons = membershipButtonsHtml(m);
    if (buttons) html += "<p class=\\"actions\\">" + buttons + "</p>";
    if (m.status === "approved") {
        html += "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Pending requests</p>";
        html += pending.length ? "<ul class=\\"plain\\">" + pending.map(pendingRequestHtml).join("") + "</ul>" : "<p class=\\"empty\\">None yet.</p>";
    }
    if (membershipOutcome) html += "<p class=\\"hint\\">" + esc(membershipOutcome) + "</p>";
    var safeRaw = "<table class=\\"kv\\"><tr><td class=\\"kv-label\\">Safe threshold</td><td class=\\"kv-value\\">" + esc(m.safe.threshold) + "</td></tr></table>" +
        "<p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Safe owners</p>" + listHtml(m.safe.owners.map(function (o) { return "<li>" + esc(o) + "</li>"; }));
    html += detailsHtml("Safe details", safeRaw);
    setBody("membership", html);
}
async function refresh() {
    try {
        var status = await (await fetch("/v1/status")).json();
        var activity = (await (await fetch("/v1/activity")).json()).entries;
        var m = status.membership;
        setBody("identity",
            badgeHtml(m.status, m.status === "approved" ? "success" : m.status === "requested" ? "warning" : "default") +
            detailsHtml("Details",
                "<table class=\\"kv\\">" +
                "<tr><td class=\\"kv-label\\">Network ID</td><td class=\\"kv-value\\">" + esc(status.networkId) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Display name</td><td class=\\"kv-value\\">" + esc(status.displayName) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Auth address</td><td class=\\"kv-value\\">" + esc(status.authAddress) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Safe address</td><td class=\\"kv-value\\">" + esc(m.safe.address) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Safe threshold</td><td class=\\"kv-value\\">" + esc(m.safe.threshold) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Identity registered</td><td class=\\"kv-value\\">" + (m.identityRegistered ? "yes" : "no") + "</td></tr>" +
                "</table><p class=\\"kv-label\\" style=\\"margin:12px 0 4px\\">Safe owners</p>" + listHtml(m.safe.owners.map(function (o) { return "<li>" + esc(o) + "</li>"; }))));
        setBody("issuer",
            badgeHtml(status.issuerKey.published ? "published" : "not published", status.issuerKey.published ? "success" : "warning") +
            detailsHtml("Details",
                "<table class=\\"kv\\">" +
                "<tr><td class=\\"kv-label\\">Public key x</td><td class=\\"kv-value\\">" + esc(status.issuerKey.x) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Public key y</td><td class=\\"kv-value\\">" + esc(status.issuerKey.y) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Approved-issuer set</td><td class=\\"kv-value\\">" + esc(status.issuerSet.address || "in-memory") + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Root</td><td class=\\"kv-value\\">" + esc(status.issuerSet.root) + "</td></tr>" +
                "<tr><td class=\\"kv-label\\">Size</td><td class=\\"kv-value\\">" + status.issuerSet.size + "</td></tr>" +
                "</table>"));
        setBody("registrations",
            detailsHtml("Details", listHtml(activity.filter(function (e) { return e.kind === "registration"; }).map(fmt))));
        setBody("activity", listHtml(activity.slice(0, 20).map(fmt)));
        renderMembership(status.membership, status.pendingRequests, status.displayName);
    } catch (err) {
        console.error("status refresh failed", err);
    }
}
document.addEventListener("click", async function (event) {
    var button = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!button || inFlight) return;
    var action = button.getAttribute("data-action");
    var path = ACTION_PATHS[action];
    if (!path) return;
    var token = heldToken() || askToken();
    if (!token) return;
    inFlight = true;
    // inFlight alone wouldn't reach these until the next render, up to 2s away.
    document.querySelectorAll("[data-action]").forEach(function (b) { b.disabled = true; });
    try {
        var body = action === "admit" ? JSON.stringify({ networkId: button.getAttribute("data-network-id") }) : undefined;
        var headers = {};
        if (body) headers["content-type"] = "application/json";
        headers["authorization"] = "Bearer " + token;
        var res = await fetch(path, { method: "POST", headers: headers, body: body });
        if (res.status === 401) forgetToken();
        var json = await res.json().catch(function () { return {}; });
        // A route that says what happened in words says it; the rest fall back to their own fields.
        membershipOutcome = res.ok
            ? (json.message || Object.keys(json).map(function (k) { return k + ": " + json[k]; }).join(", "))
            : (json.error || ("request failed: " + res.status));
    } catch (err) {
        membershipOutcome = "request failed: " + err;
    } finally {
        inFlight = false;
    }
    refresh();
});
refresh();
setInterval(refresh, 2000);
`
}

export function buildStatusPage(data: StatusPageData): string {
    const links = linksPanel(data)
    const panels = [
        identityPanel(data),
        membershipPanel(data),
        issuerPanel(data),
        registrationsPanel(data),
        activityPanel(data),
        ...(links ? [links] : [])
    ]
    const tabs: Tab[] = [
        {
            key: "actions",
            label: "Actions",
            intro: "What this org can do right now.",
            note: "Each button sends this org's member server token. The page asks for it on the first click and keeps it for this tab; a 401 clears it and asks again.",
            panelIds: ["membership"]
        },
        { key: "activity", label: "Activity", intro: "What it has done.", panelIds: ["activity", "registrations"] },
        {
            key: "details",
            label: "Details",
            intro: "Its keys and addresses.",
            panelIds: links ? ["identity", "issuer", "links"] : ["identity", "issuer"]
        }
    ]

    return renderPage({
        title: `${data.displayName} status`,
        subtitle: "One organisation's own page on the demo network",
        panels,
        tabs,
        tabScope: "org",
        script: tabsScript() + pollingScript(),
        accent: data.accent
    })
}
