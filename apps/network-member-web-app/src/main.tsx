import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createLinkClient } from "@coordination-network/user-app-link"
import { createRelayWebLinkTransport, browserSessionKey } from "@coordination-network/user-app-link/web"
import { branding } from "./business/branding"
import { loggingHooks } from "./business/hooks"
import { policyForMember, programmeForMember, type ProgrammeProfile } from "./business/policy"
import { createMemberFlows, type StackConfig } from "./flows"
import "./styles.css"

type Action = "enrol" | "issue" | "verify" | "revoke"
type Stage = "ready" | "registered" | "active" | "confirmed" | "revoked" | "denied"
type Area = "participants" | "membership"
type Flows = ReturnType<typeof createMemberFlows>
type AdmissionStatus = {
    candidateName: string
    profileUrl?: string
    state: "not-requested" | "pending" | "admitted" | "departed"
    approvals: string[]
    threshold: number
    canRequest: boolean
    canApprove: boolean
    canLeave: boolean
    hasApproved: boolean
    earlyCompletionBlocked: boolean
    outdatedDecisionBlocked: boolean
}

function sessionId(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function pages(
    profile: ProgrammeProfile
): Record<Stage, { eyebrow: string; title: string; body: string; action?: string }> {
    return {
        ready: {
            eyebrow: "Identity registration",
            title: "Register a user",
            body: "Ask the user to approve registration of their private wallet identity.",
            action: "Request registration"
        },
        registered: {
            eyebrow: "Identity registered",
            title: "Issue a participation approval",
            body: `The user is registered. Approve their participation in ${profile.programmeName} for ${profile.countryName}.`,
            action: "Issue approval"
        },
        active: {
            eyebrow: "Approval valid",
            title: "The user is approved to participate",
            body: `Verify their ${profile.programmeName} approval for ${profile.countryName} without requesting personal information.`,
            action: "Verify participation"
        },
        confirmed: {
            eyebrow: "Participation verified",
            title: "The approval is valid",
            body: `${profile.programmeName} participation for ${profile.countryName} is confirmed. No personal details were revealed.`,
            action: "Verify again"
        },
        revoked: {
            eyebrow: "Approval revoked",
            title: "Participation approval withdrawn",
            body: "The user’s wallet will update automatically. Verify again to demonstrate that the revoked approval is refused.",
            action: "Verify revoked approval"
        },
        denied: {
            eyebrow: "Verification refused",
            title: "The revoked approval was rejected",
            body: `The user can no longer prove approval for ${profile.programmeName} in ${profile.countryName}.`
        }
    }
}

function MembershipView({
    memberName,
    statusUrl,
    admission,
    busy,
    notice,
    act
}: {
    memberName: string
    statusUrl: string
    admission?: AdmissionStatus
    busy: boolean
    notice: string
    act: (action: "request" | "approve" | "leave") => void
}) {
    if (!admission) {
        return (
            <div className="panel">
                <p className="eyebrow">Network membership</p>
                <h1>Manage network membership</h1>
                <a href={statusUrl} target="_blank" rel="noreferrer">
                    Open member status
                </a>
            </div>
        )
    }
    const candidate = `${admission.candidateName.charAt(0).toUpperCase()}${admission.candidateName.slice(1)}`
    const isCandidate = memberName === admission.candidateName
    const title =
        admission.state === "departed"
            ? `${candidate} left the network`
            : admission.state === "admitted"
              ? `${candidate} joined the network`
              : admission.state === "pending"
                ? isCandidate
                    ? "Membership review in progress"
                    : `${candidate} wants to join`
                : isCandidate
                  ? "Join the coordination network"
                  : "No membership requests"
    const body =
        admission.state === "departed"
            ? `${candidate} is no longer a network member. Approvals previously issued by ${candidate} are no longer recognised.`
            : admission.state === "admitted"
              ? `${candidate} is now an approved network member and can issue recognised participation approvals.`
              : admission.state === "pending"
                ? `${admission.approvals.length} of ${admission.threshold} required members have approved the request.`
                : isCandidate
                  ? "Send a membership request to Alpha and Beta. The request does not grant access until enough members approve it."
                  : "New organisation requests will appear here for review."

    return (
        <div className={`panel ${admission.state === "admitted" ? "result" : ""}`}>
            {admission.state === "admitted" && <div className="result-icon">✓</div>}
            <p className="eyebrow">Network membership</p>
            <h1>{title}</h1>
            <p className="lead">{body}</p>
            {!isCandidate && admission.state === "pending" && admission.profileUrl && (
                <a className="profile-link" href={admission.profileUrl} target="_blank" rel="noreferrer">
                    Review organisation profile
                </a>
            )}
            {admission.state === "pending" && admission.approvals.length > 0 && (
                <p className="approval-list-copy">
                    Approved by{" "}
                    {admission.approvals.map((name) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`).join(", ")}
                </p>
            )}
            {isCandidate && admission.state === "not-requested" && (
                <p className="membership-note">The requesting organisation pays for this request.</p>
            )}
            {admission.hasApproved && admission.state === "pending" && (
                <div className="success-note">You approved this membership request.</div>
            )}
            {admission.outdatedDecisionBlocked && admission.state === "pending" && (
                <div className="success-note">An outdated membership decision was safely refused.</div>
            )}
            {admission.earlyCompletionBlocked && admission.state === "pending" && (
                <div className="success-note">The request cannot complete until enough members approve it.</div>
            )}
            {notice && (
                <div className={`notice ${busy ? "working" : "error"}`} role="status">
                    {notice}
                </div>
            )}
            <div className="panel-actions">
                {admission.canRequest && (
                    <button className="primary" disabled={busy} onClick={() => act("request")}>
                        {busy ? "Sending request…" : "Request membership"}
                    </button>
                )}
                {admission.canApprove && (
                    <button className="primary" disabled={busy} onClick={() => act("approve")}>
                        {busy ? "Recording approval…" : `Approve ${candidate}`}
                    </button>
                )}
                {admission.canLeave && (
                    <button className="secondary" disabled={busy} onClick={() => act("leave")}>
                        {busy ? "Leaving network…" : "Leave network"}
                    </button>
                )}
            </div>
        </div>
    )
}

function App() {
    const [member, setMember] = useState<{ name: string; approved?: boolean; serverUrl: string }>({
        name: "Member portal",
        approved: true,
        serverUrl: ""
    })
    const [programme, setProgramme] = useState(() => programmeForMember("alpha"))
    const [area, setArea] = useState<Area>("participants")
    const [admission, setAdmission] = useState<AdmissionStatus>()
    const [stage, setStage] = useState<Stage>("ready")
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState("")
    const flows = useRef<Flows | undefined>(undefined)
    const stageRef = useRef<Stage>("ready")

    const moveTo = (next: Stage) => {
        stageRef.current = next
        setStage(next)
    }

    useEffect(() => {
        let active = true
        let admissionTimer: number | undefined
        void fetch("/stack.json")
            .then(async (response) => {
                if (!response.ok) throw new Error("unavailable")
                const stack = (await response.json()) as StackConfig
                const publicMember = stack.members.find(({ appOrigin }, index) =>
                    appOrigin ? new URL(appOrigin).port === location.port : Number(location.port) === 4174 + index
                )
                const selected = publicMember
                    ? {
                          ...publicMember,
                          memberServerToken: browserSessionKey(publicMember.serverUrl, window, "memberKey")
                      }
                    : undefined
                if (!selected) throw new Error("not configured")
                setMember(selected)
                setProgramme(programmeForMember(selected.name))
                document.title = `${selected.name} · ${branding.productName}`
                document.documentElement.style.setProperty("--accent", branding.accentColor)
                const senderKey = `coordination-relay-sender:${selected.name}`
                const sender = sessionStorage.getItem(senderKey) ?? `${location.origin}#${sessionId()}`
                sessionStorage.setItem(senderKey, sender)
                const relayUrl = stack.apps?.relay.url ?? `${location.protocol}//${location.hostname}:4177`
                const relay = createRelayWebLinkTransport({ relayUrl, sender, token: browserSessionKey(relayUrl) })
                flows.current = createMemberFlows({
                    member: selected,
                    stack,
                    link: createLinkClient({
                        caller: { name: selected.name, scheme: location.origin },
                        callback: `${selected.scheme ?? "memberapp"}://v1/response`,
                        ...relay
                    }),
                    policy: policyForMember(selected.name),
                    hooks: loggingHooks,
                    registrationStore: sessionStorage
                })
                if (flows.current.state.identity) moveTo("registered")
                const refreshAdmission = async () => {
                    const response = await fetch(`${selected.serverUrl}/v1/admission`, {
                        headers: { authorization: `Bearer ${selected.memberServerToken}` }
                    })
                    if (response.status === 404) return false
                    if (!response.ok) throw new Error("membership status unavailable")
                    if (active) setAdmission((await response.json()) as AdmissionStatus)
                    return true
                }
                if (await refreshAdmission()) {
                    admissionTimer = window.setInterval(() => void refreshAdmission().catch(() => undefined), 1_000)
                }
            })
            .catch(() => setNotice("We couldn’t open this service. Please refresh and try again."))
        return () => {
            active = false
            if (admissionTimer !== undefined) window.clearInterval(admissionTimer)
        }
    }, [])

    const run = async (action: Action) => {
        if (!flows.current || busy) return
        setBusy(true)
        setNotice(
            action === "enrol"
                ? "Waiting for the user to confirm registration…"
                : action === "issue"
                  ? "Issuing participation approval…"
                  : action === "verify"
                    ? "Waiting for the user to confirm participation…"
                    : "Revoking approval…"
        )
        try {
            await flows.current[action]()
            setNotice("")
            moveTo(
                action === "enrol"
                    ? "registered"
                    : action === "issue"
                      ? "active"
                      : action === "verify"
                        ? "confirmed"
                        : "revoked"
            )
        } catch (error) {
            console.error(error)
            if (action === "verify" && stageRef.current === "revoked") {
                moveTo("denied")
                setNotice("")
            } else setNotice("The request was not completed. You can try again.")
        } finally {
            setBusy(false)
        }
    }

    const page = pages(programme)[stage]
    const action: Action | undefined =
        stage === "ready"
            ? "enrol"
            : stage === "registered"
              ? "issue"
              : ["active", "confirmed", "revoked"].includes(stage)
                ? "verify"
                : undefined
    const canRevoke = stage === "active" || stage === "confirmed"
    const runAdmission = async (action: "request" | "approve" | "leave") => {
        if (busy) return
        setBusy(true)
        setNotice(
            action === "request"
                ? "Sending membership request…"
                : action === "approve"
                  ? "Recording your approval…"
                  : "Leaving the network…"
        )
        try {
            const response = await fetch(`/stack.json`)
            const stack = (await response.json()) as StackConfig
            const publicMember = stack.members.find(({ appOrigin }, index) =>
                appOrigin ? new URL(appOrigin).port === location.port : Number(location.port) === 4174 + index
            )
            const selected = publicMember
                ? { ...publicMember, memberServerToken: browserSessionKey(publicMember.serverUrl, window, "memberKey") }
                : undefined
            if (!selected) throw new Error("not configured")
            const result = await fetch(`${selected.serverUrl}/v1/admission/${action}`, {
                method: "POST",
                headers: { authorization: `Bearer ${selected.memberServerToken}` }
            })
            if (!result.ok) throw new Error("membership action failed")
            setAdmission((await result.json()) as AdmissionStatus)
            setNotice("")
        } catch {
            setNotice("The membership action was not completed. You can try again.")
        } finally {
            setBusy(false)
        }
    }

    return (
        <main>
            <header>
                <a className="brand" href="/" aria-label={`${member.name} home`}>
                    <span aria-hidden="true">{member.name.charAt(0).toUpperCase()}</span>
                    <strong>{member.name}</strong>
                </a>
                <div className="header-actions">
                    <button
                        className={area === "participants" ? "selected" : ""}
                        onClick={() => setArea("participants")}
                    >
                        User approvals
                    </button>
                    <button className={area === "membership" ? "selected" : ""} onClick={() => setArea("membership")}>
                        Network membership
                    </button>
                </div>
            </header>
            <section className="workspace">
                {area === "participants" ? (
                    <>
                        <div className="timeline" aria-label="Participation approval progress">
                            <span className={stage !== "ready" ? "done" : ""}>Registration</span>
                            <span
                                className={
                                    ["registered", "active", "confirmed", "revoked", "denied"].includes(stage)
                                        ? "done"
                                        : ""
                                }
                            >
                                Registered
                            </span>
                            <span
                                className={["active", "confirmed", "revoked", "denied"].includes(stage) ? "done" : ""}
                            >
                                Approval
                            </span>
                            <span className={["confirmed", "revoked", "denied"].includes(stage) ? "done" : ""}>
                                Verification
                            </span>
                        </div>
                        <div className={`panel ${["confirmed", "denied"].includes(stage) ? "result" : ""}`}>
                            {["confirmed", "denied"].includes(stage) && (
                                <div className={`result-icon ${stage === "denied" ? "denied" : ""}`}>
                                    {stage === "denied" ? "×" : "✓"}
                                </div>
                            )}
                            <p className="eyebrow">{page.eyebrow}</p>
                            <h1>{page.title}</h1>
                            <p className="lead">{page.body}</p>
                            {notice && (
                                <div className={`notice ${busy ? "working" : "error"}`} role="status">
                                    {notice}
                                </div>
                            )}
                            <div className="panel-actions">
                                {action && (
                                    <button
                                        className="primary"
                                        data-action={action}
                                        disabled={busy}
                                        onClick={() => void run(action)}
                                    >
                                        {busy ? "Please wait…" : page.action}
                                    </button>
                                )}
                                {canRevoke && (
                                    <button
                                        className="secondary"
                                        data-action="revoke"
                                        disabled={busy}
                                        onClick={() => void run("revoke")}
                                    >
                                        Revoke approval
                                    </button>
                                )}
                            </div>
                        </div>
                    </>
                ) : (
                    <MembershipView
                        memberName={member.name}
                        statusUrl={member.serverUrl}
                        admission={admission}
                        busy={busy}
                        notice={notice}
                        act={(action) => void runAdmission(action)}
                    />
                )}
            </section>
            <footer>
                <span>Member services</span>
                <span>Requests are sent to the user’s wallet</span>
            </footer>
        </main>
    )
}

createRoot(document.querySelector("#root")!).render(<App />)
