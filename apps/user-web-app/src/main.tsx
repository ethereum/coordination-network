import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { Wallet, type ChainStateLoader } from "@coordination-network/wallet"
import {
    createRequestHandler,
    decodeRequest,
    decodeResponse,
    type CredentialIssueResult,
    type DecodedLinkRequest
} from "@coordination-network/user-app-link"
import { browserSessionKey, respondToWebLinkRequest } from "@coordination-network/user-app-link/web"
import { memberChainStateLoader } from "./chain-state"
import { createUserHandlers } from "./handlers"
import { loadOrCreateIdentity } from "./identity"
import { IndexedDbStore, PrefixedStore } from "./indexeddb-store"
import { cleanWalletUrl, resetWallet } from "./navigation"
import { requiresUserReview } from "./request-policy"
import { WorkerProofGenerator } from "./worker-prover"
import "./styles.css"

type Member = {
    name: string
    networkId: string
    serverUrl: string
    appOrigin?: string
    approved?: boolean
    role?: string
}
type Stack = { apps?: { relay: { url: string } }; members: Member[] }
type View = {
    registrations: number
    approvals: Array<{
        memberName: string
        credential: { status: string }
        programme?: string
        country?: string
    }>
    proofShared: boolean
}
type Permission = { request: DecodedLinkRequest; resolve: (allowed: boolean) => void }
type Incoming = { seq: number; sender: string; url: string; request: DecodedLinkRequest }
const store = new IndexedDbStore()
const USER_NAME = "User 1"

function sessionId(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const copy: Record<DecodedLinkRequest["op"], [string, string, string]> = {
    "registration.sign": [
        "Register with this member?",
        "This lets the member register your wallet identity. Requested by",
        "Confirm registration"
    ],
    "credential.issue": [
        "Receive participation approval?",
        "The approval will be verified and saved privately.",
        "Continue"
    ],
    "presentation.create": [
        "Confirm your participation approval?",
        "We’ll only confirm whether your approval matches the required programme and country.",
        "Confirm participation"
    ]
}

function allowedOrigins(stack: Stack) {
    return [
        ...new Set(
            stack.members.flatMap(({ appOrigin }, index) => {
                const url = new URL(appOrigin ?? `${location.protocol}//${location.hostname}:${4174 + index}`)
                return [url.origin, `${url.protocol}//localhost:${url.port}`, `${url.protocol}//127.0.0.1:${url.port}`]
            })
        )
    ]
}

const statusCopy: Record<string, { label: string; detail: string }> = {
    valid: { label: "Active", detail: "Ready to use" },
    revoked: { label: "Revoked", detail: "This approval can no longer be used" },
    expired: { label: "Expired", detail: "This approval has expired" },
    "not-yet-valid": { label: "Pending", detail: "This approval is not valid yet" },
    "issuer-not-approved": { label: "Unavailable", detail: "This approval is no longer recognised" }
}

function humanizeProgramme(programme: string): string {
    return programme
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(" ")
}

function countryName(code: string): string {
    return (
        ({ ZZZ: "Demo Country", XAA: "Demo Country A", XAB: "Demo Country B" } as Record<string, string>)[code] ?? code
    )
}

function memberDisplayName(name: string): string {
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function WalletView({ view, notice }: { view: View; notice: string }) {
    const hasApprovals = view.approvals.length > 0
    return (
        <section className="wallet-content">
            {hasApprovals ? (
                <div className="approval-list" aria-label="Participation approvals">
                    {view.approvals.map((approval) => {
                        const active = approval.credential.status === "valid"
                        const status = statusCopy[approval.credential.status] ?? statusCopy["issuer-not-approved"]
                        return (
                            <article className={`pass ${active ? "active" : "inactive"}`} key={approval.memberName}>
                                <div className="pass-top">
                                    <span>PARTICIPATION APPROVAL</span>
                                    <b>{status.label}</b>
                                </div>
                                <div className="pass-mark">{USER_NAME}</div>
                                <div>
                                    <h2>
                                        {approval.programme
                                            ? humanizeProgramme(approval.programme)
                                            : "Programme approval"}
                                    </h2>
                                    {approval.country && (
                                        <p className="approval-scope">{countryName(approval.country)}</p>
                                    )}
                                    <p>Issued by {memberDisplayName(approval.memberName)}</p>
                                    <p>{status.detail}</p>
                                </div>
                            </article>
                        )
                    })}
                </div>
            ) : (
                <div className="empty-state">
                    <div className="empty-mark" aria-hidden="true">
                        ◇
                    </div>
                    <h2>No approvals yet</h2>
                    <p>Participation approvals issued to you will appear here.</p>
                </div>
            )}
            {view.registrations > 0 && !hasApprovals && (
                <p className="pending">Your identity is registered. No participation approval has been issued yet.</p>
            )}
            {notice && (
                <div className="success" role="status">
                    {notice}
                </div>
            )}
            {view.approvals.some(({ credential }) => credential.status === "revoked") && (
                <div className="revoked-notice" role="status">
                    A participation approval was revoked. Your wallet updated automatically.
                </div>
            )}
            {view.approvals.some(({ credential }) => credential.status === "valid") && view.proofShared && (
                <div className="success" role="status">
                    Proof sent. Check the verifier for the result.
                </div>
            )}
        </section>
    )
}

function PermissionView({ permission, answer }: { permission: Permission; answer: (allowed: boolean) => void }) {
    const [title, detail, action] = copy[permission.request.op]!
    const member = memberDisplayName(permission.request.caller.name)
    return (
        <section className="permission" aria-labelledby="permission-title">
            <div className="request-mark" aria-hidden="true">
                {member.charAt(0).toUpperCase()}
            </div>
            <p className="request-from">Request from {member}</p>
            <h2 id="permission-title">{title}</h2>
            <p>{permission.request.op === "registration.sign" ? `${detail} ${member}.` : detail}</p>
            <div className="actions">
                <button onClick={() => answer(false)}>Not now</button>
                <button className="primary" onClick={() => answer(true)}>
                    {action}
                </button>
            </div>
        </section>
    )
}

function RequestView({ incoming, review, error }: { incoming: Incoming; review: () => void; error?: string }) {
    const member = memberDisplayName(incoming.request.caller.name)
    const [label, detail] =
        incoming.request.op === "registration.sign"
            ? ["Identity registration", `${member} wants to register your wallet identity.`]
            : incoming.request.op === "presentation.create"
              ? ["Approval verification", `${member} wants to verify your participation approval.`]
              : ["Wallet request", `${member} wants you to review a request.`]
    return (
        <section className="permission request-notification">
            {error && (
                <p className="request-error" role="alert">
                    {error}
                </p>
            )}
            <div className="request-mark" aria-hidden="true">
                {member.charAt(0).toUpperCase()}
            </div>
            <p className="request-from">New from {member}</p>
            <h2>{label}</h2>
            <p>{detail}</p>
            <button className="review-button" onClick={review}>
                Review request
            </button>
        </section>
    )
}

function ProcessingView({ operation }: { operation: DecodedLinkRequest["op"] }) {
    const checking = operation === "presentation.create"
    return (
        <section className="permission processing" aria-live="polite">
            <div className="spinner" aria-hidden="true" />
            <p className="request-from">Please keep this page open</p>
            <h2>{checking ? "Verifying your approval…" : "Sending your response…"}</h2>
            <p>
                {checking
                    ? "This private check can take a little while. You can continue when it finishes."
                    : "Your wallet is securely completing the request."}
            </p>
        </section>
    )
}

function App() {
    const [view, setView] = useState<View>({ registrations: 0, approvals: [], proofShared: false })
    const [permission, setPermission] = useState<Permission>()
    const [error, setError] = useState("")
    const [resetting, setResetting] = useState(false)
    const [incoming, setIncoming] = useState<Incoming>()
    const [processing, setProcessing] = useState(false)
    const [requestError, setRequestError] = useState("")
    const [walletNotice, setWalletNotice] = useState("")
    const processIncoming = useRef<((message: Incoming) => Promise<void>) | undefined>(undefined)

    useEffect(() => {
        let active = true
        async function boot() {
            const response = await fetch("/stack.json")
            if (!response.ok) throw new Error("Wallet service is unavailable")
            const stack = (await response.json()) as Stack
            const relayUrl = new URL(stack.apps?.relay.url ?? `${location.protocol}//${location.hostname}:4177`).origin
            const token = browserSessionKey(relayUrl)
            const relayHeaders = { authorization: `Bearer ${token}` }
            const identity = await loadOrCreateIdentity(store)
            const trusted = stack.members.find(({ approved, role }) => approved ?? role === "founder")
            if (!trusted) throw new Error("No approved member service is available")
            const memberById = new Map(stack.members.map((member) => [member.networkId.toLowerCase(), member]))
            const memberByOrigin = new Map(stack.members.map((member) => [new URL(member.serverUrl).origin, member]))
            const wallets = new Map<string, Wallet>()
            let proofShared = false
            const memberFor = (value: string) =>
                value.startsWith("http")
                    ? memberByOrigin.get(new URL(value).origin)
                    : memberById.get(value.toLowerCase())
            const walletFor = (value: string, loadChainState?: ChainStateLoader) => {
                const member = memberFor(value)
                if (!member) throw new Error("Unknown member service")
                // An issuance uses its preloaded trees; background sync keeps its live loader.
                let wallet = loadChainState ? undefined : wallets.get(member.networkId)
                if (!wallet) {
                    wallet = new Wallet({
                        identitySeed: identity.identitySeed,
                        deviceSigner: identity.deviceSigner,
                        store: new PrefixedStore(store, `app:wallet:${member.networkId.toLowerCase()}:`),
                        consent: async () => true,
                        loadChainState: loadChainState ?? memberChainStateLoader(member.serverUrl),
                        proofGenerator: new WorkerProofGenerator()
                    })
                    if (!loadChainState) wallets.set(member.networkId, wallet)
                }
                return wallet
            }

            // Preserve approvals created by older demo builds that used one unscoped wallet store.
            for (const member of stack.members) {
                const id = await store.get(`app:credential:${member.networkId.toLowerCase()}`)
                if (!id) continue
                const legacyRecord = await store.get(`vc:${id}`)
                const scopedKey = `app:wallet:${member.networkId.toLowerCase()}:vc:${id}`
                if (legacyRecord && !(await store.get(scopedKey))) await store.set(scopedKey, legacyRecord)
            }

            const refresh = async () => {
                const keys = await store.list()
                const registrations = keys.filter((key) => key.startsWith("app:registration:")).length
                const approvals = (
                    await Promise.all(
                        stack.members.map(async (member) => {
                            const issuer = member.networkId.toLowerCase()
                            const id = await store.get(`app:credential:${issuer}`)
                            if (!id) return undefined
                            const credential = await walletFor(member.networkId).getCredential(id)
                            if (!credential) return undefined
                            const rawMetadata = await store.get(`app:credential-meta:${issuer}`)
                            const metadata = rawMetadata
                                ? (JSON.parse(rawMetadata) as { programme?: string; country?: string })
                                : undefined
                            return {
                                memberName: member.name,
                                credential,
                                programme: metadata?.programme,
                                country: metadata?.country
                            }
                        })
                    )
                ).filter((approval): approval is NonNullable<typeof approval> => Boolean(approval))
                if (active) setView({ registrations, approvals, proofShared })
            }
            const consent = async (nextRequest: DecodedLinkRequest) => {
                if (!requiresUserReview(nextRequest.op)) {
                    return true
                }
                return new Promise<boolean>((resolve) => setPermission({ request: nextRequest, resolve }))
            }
            const handler = createRequestHandler({
                handlers: createUserHandlers({
                    identity,
                    serverUrlFor: (issuer) => memberById.get(issuer.toLowerCase())?.serverUrl,
                    walletFor,
                    store,
                    onPresentationShared: () => {
                        proofShared = true
                    }
                }),
                consent
            })
            await refresh()
            if (new URL(location.href).searchParams.has("payload")) {
                await respondToWebLinkRequest({
                    handler,
                    allowedMemberOrigins: allowedOrigins(stack),
                    closeAfterResponding: false
                })
                await refresh()
            }
            const consumerKey = "coordination-relay-consumer"
            const consumerId = sessionStorage.getItem(consumerKey) ?? sessionId()
            sessionStorage.setItem(consumerKey, consumerId)
            const relayHealth = await fetch(`${relayUrl}/health`).then(
                (result) => result.json() as Promise<{ instanceId: string; latestSequence: number }>
            )
            const savedCursor = JSON.parse(sessionStorage.getItem("coordination-relay-cursor") ?? "null") as {
                instanceId: string
                after: number
            } | null
            let requestAfter = savedCursor?.instanceId === relayHealth.instanceId ? savedCursor.after : 0
            let waiting: Incoming | undefined
            const queued: Incoming[] = []
            const postResponse = async (message: Incoming, url: string) => {
                const delivered = await fetch(`${relayUrl}/v1/responses`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...relayHeaders },
                    body: JSON.stringify({ sender: message.sender, consumer: consumerId, url })
                })
                if (!delivered.ok) throw new Error("Response could not be delivered")
            }
            const showNext = () => {
                waiting = queued.shift()
                setIncoming(waiting)
            }
            const respond = async (message: Incoming) => {
                const responseUrl = await handler.handle(message.url)
                await postResponse(message, responseUrl)
                await refresh()
                const response = decodeResponse(responseUrl)
                if (
                    message.request.op === "credential.issue" &&
                    response.ok &&
                    (response.result as CredentialIssueResult).status === "stored"
                ) {
                    setWalletNotice(
                        `${memberDisplayName(message.request.caller.name)} issued your participation approval.`
                    )
                }
            }
            processIncoming.current = async (message) => {
                setProcessing(true)
                setRequestError("")
                try {
                    await respond(message)
                    waiting = undefined
                    showNext()
                } catch {
                    setRequestError("We couldn’t complete this request. Please try again.")
                } finally {
                    setProcessing(false)
                }
            }
            let polling = false
            const pollRequests = async () => {
                if (!active || polling) return
                polling = true
                try {
                    const pending = await fetch(
                        `${relayUrl}/v1/requests?after=${requestAfter}&consumer=${encodeURIComponent(consumerId)}`,
                        { headers: relayHeaders }
                    )
                    if (!pending.ok) return
                    const messages = (await pending.json()) as Array<{ seq: number; sender: string; url: string }>
                    for (const message of messages) {
                        requestAfter = Math.max(requestAfter, message.seq)
                        sessionStorage.setItem(
                            "coordination-relay-cursor",
                            JSON.stringify({ instanceId: relayHealth.instanceId, after: requestAfter })
                        )
                        void fetch(
                            `${relayUrl}/v1/requests?after=${requestAfter}&consumer=${encodeURIComponent(consumerId)}`,
                            { method: "DELETE", headers: relayHeaders }
                        ).catch(() => undefined)
                        const next = { ...message, request: decodeRequest(message.url) }
                        if (!requiresUserReview(next.request.op)) {
                            await respond(next)
                        } else {
                            queued.push(next)
                            if (!waiting) showNext()
                        }
                    }
                } catch {
                    // Retry temporary relay failures on the next poll.
                } finally {
                    polling = false
                }
            }
            void pollRequests()
            const requestTimer = window.setInterval(() => void pollRequests(), 500)
            const statusTimer = window.setInterval(() => {
                void Promise.all(
                    stack.members.map(async (member) => {
                        const id = await store.get(`app:credential:${member.networkId.toLowerCase()}`)
                        if (id) await walletFor(member.networkId).syncRevocations()
                    })
                )
                    .then(refresh)
                    .catch(() => undefined)
            }, 2_000)
            return () => {
                window.clearInterval(requestTimer)
                window.clearInterval(statusTimer)
                processIncoming.current = undefined
            }
        }
        let stopStatus: (() => void) | undefined
        void boot()
            .then((stop) => {
                if (active) stopStatus = stop
                else stop()
            })
            .catch(() => active && setError("We couldn’t open your wallet. Please close it and try again."))
        return () => {
            active = false
            stopStatus?.()
        }
    }, [])

    const answer = (allowed: boolean) => {
        permission?.resolve(allowed)
        setPermission(undefined)
    }
    const reset = async () => {
        if (resetting) return
        setResetting(true)
        setError("")
        try {
            await resetWallet(store)
            setView({ registrations: 0, approvals: [], proofShared: false })
            setWalletNotice("")
            location.replace(cleanWalletUrl(location.href))
        } catch {
            setError("We couldn’t clear the wallet. Close other wallet windows and try again.")
            setResetting(false)
        }
    }

    return (
        <main>
            <header>
                <div className="wallet-brand">
                    <span aria-hidden="true">U1</span>
                    <div>
                        <small>Personal wallet</small>
                        <h1>{USER_NAME}</h1>
                    </div>
                </div>
                <span className="private">
                    <i /> Private
                </span>
            </header>
            {permission ? (
                <PermissionView permission={permission} answer={answer} />
            ) : processing && incoming ? (
                <ProcessingView operation={incoming.request.op} />
            ) : incoming ? (
                <RequestView
                    incoming={incoming}
                    error={requestError}
                    review={() => void processIncoming.current?.(incoming)}
                />
            ) : error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : (
                <WalletView view={view} notice={walletNotice} />
            )}
            <footer>
                <span>Only you control what leaves this wallet.</span>
                <button onClick={() => void reset()} disabled={resetting}>
                    {resetting ? "Clearing…" : "Clear wallet"}
                </button>
            </footer>
        </main>
    )
}

createRoot(document.querySelector("#root")!).render(<App />)
