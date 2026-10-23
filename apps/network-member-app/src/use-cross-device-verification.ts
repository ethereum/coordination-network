import { useEffect, useRef, useState } from "react"
import {
    MemberServerError,
    type MemberFlows,
    type PresentationChallenge,
    type VerificationResponse
} from "@coordination-network/network-member-app-core"

type Request = PresentationChallenge & { programme: string; country: string }

/** Owned by App, so tab changes do not cancel a check or discard its verdict. */
export function useCrossDeviceVerification(flows: MemberFlows | null) {
    const [visible, setVisible] = useState(false)
    const [request, setRequest] = useState<Request | null>(null)
    const [result, setResult] = useState<VerificationResponse | null>(null)
    const [terminal, setTerminal] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [retry, setRetry] = useState(0)
    const [starting, setStarting] = useState(false)
    const [cancelling, setCancelling] = useState(false)
    const epoch = useRef(0)
    const requestRef = useRef<PresentationChallenge | null>(null)

    useEffect(() => {
        setVisible(false)
        setRequest(null)
        setResult(null)
        setTerminal(null)
        setError(null)
        setStarting(false)
        setCancelling(false)
        return () => {
            epoch.current++
            const pending = requestRef.current
            requestRef.current = null
            if (pending) void flows?.cancelPresentation(pending.requestId).catch(() => undefined)
        }
    }, [flows])

    async function start(input: { programme: string; country: string }) {
        if (!flows) return
        const current = ++epoch.current
        setStarting(true)
        setRequest(null)
        setError(null)
        setTerminal(null)
        setResult(null)
        try {
            const next = await flows.startPresentation(input)
            if (current !== epoch.current) {
                void flows.cancelPresentation(next.requestId).catch(() => undefined)
                return
            }
            requestRef.current = next
            setRequest({ ...next, ...input })
        } catch {
            if (current === epoch.current) setError("Could not create a request. Check your connection and try again.")
        } finally {
            if (current === epoch.current) setStarting(false)
        }
    }

    useEffect(() => {
        if (!flows || !request || result || terminal || cancelling) return
        let active = true
        const current = epoch.current
        let timer: ReturnType<typeof setTimeout> | undefined
        let requestTimeout: ReturnType<typeof setTimeout> | undefined
        const poll = async () => {
            try {
                const status = await Promise.race([
                    flows.presentationStatus(request.requestId),
                    new Promise<never>((_resolve, reject) => {
                        requestTimeout = setTimeout(() => reject(new Error("Status lookup timed out")), 10000)
                    })
                ])
                if (requestTimeout) clearTimeout(requestTimeout)
                if (!active || current !== epoch.current) return
                if (status.status === "completed") {
                    if (status.verification.requestId !== request.requestId) throw new Error("Wrong request")
                    requestRef.current = null
                    setResult(status.verification)
                } else if (status.status === "expired" || status.status === "cancelled") {
                    requestRef.current = null
                    setTerminal(
                        status.status === "expired" ? "Request expired. Start a new check." : "Request cancelled."
                    )
                } else timer = setTimeout(() => void poll(), 1500)
            } catch (error) {
                if (requestTimeout) clearTimeout(requestTimeout)
                if (!active || current !== epoch.current) return
                if (error instanceof MemberServerError && error.code === "NOT_FOUND") {
                    requestRef.current = null
                    setTerminal("Request is no longer available. Start a new check.")
                } else setError("Could not confirm the result. Check your connection, then retry status.")
            }
        }
        void poll()
        return () => {
            active = false
            if (timer) clearTimeout(timer)
            if (requestTimeout) clearTimeout(requestTimeout)
        }
    }, [flows, request, result, terminal, retry, cancelling])

    async function cancel() {
        const pending = requestRef.current
        if (!pending || !flows || cancelling) return
        const current = ++epoch.current
        setCancelling(true)
        setError(null)
        try {
            const status = await flows.cancelPresentation(pending.requestId)
            if (current !== epoch.current) return
            if (status === 409) {
                // The server already accepted the submission and will still record a verdict.
                setRetry((value) => value + 1)
            } else {
                requestRef.current = null
                setTerminal("Request cancelled.")
            }
        } catch {
            if (current === epoch.current) {
                requestRef.current = null
                setTerminal("Stopped waiting. A proof already submitted may still be recorded by the server.")
                setError("Could not cancel on the server. The request will expire.")
            }
        } finally {
            if (current === epoch.current) setCancelling(false)
        }
    }

    return {
        visible,
        request,
        result,
        terminal,
        error,
        starting,
        cancelling,
        start,
        cancel,
        open: () => setVisible(true),
        close: () => setVisible(false),
        retryStatus: () => {
            setError(null)
            setRetry((value) => value + 1)
        }
    }
}

export type CrossDeviceVerification = ReturnType<typeof useCrossDeviceVerification>
