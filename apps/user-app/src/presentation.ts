import { decodePresentationQr, LinkError, type DecodedLinkRequest } from "@coordination-network/user-app-link"
import type { UserAppService, HttpClient } from "@coordination-network/user-app-core"
import type { StackDescriptor } from "./config"

/** A scanned QR is untrusted. Pin every URL and the audience to a previously configured member. */
export function trustedPresentation(raw: string, stack: StackDescriptor | null, now = Date.now()) {
    const qr = decodePresentationQr(raw)
    const member = stack?.members.find(({ serverUrl, networkId }) => {
        const base = serverUrl.replace(/\/$/, "")
        return (
            qr.params.audience === networkId &&
            qr.params.responseUrl === `${base}/v1/verify` &&
            qr.params.issuersUrl === `${base}/v1/issuers` &&
            qr.params.revocationsUrl === `${base}/v1/revocations/snapshot`
        )
    })
    if (!member) throw new Error("This verifier is not in your configured network. Check your wallet configuration.")
    if (Math.floor(now / 1000) > qr.expiresAt || qr.expiresAt <= qr.params.currentTime)
        throw new Error("This challenge has expired. Ask for a new QR.")
    if (Math.abs(Math.floor(now / 1000) - qr.params.currentTime) > 300)
        throw new Error("This challenge is out of date. Ask for a new QR.")
    const request: DecodedLinkRequest = {
        id: qr.params.requestId,
        version: "v1",
        op: "presentation.create",
        params: qr.params,
        caller: { name: member.name, scheme: member.scheme ?? "verifier" },
        // Used only by the consent summary, never opened on this cross-device path.
        callback: `${member.scheme ?? "verifier"}://v1/response`
    }
    return { request, params: qr.params, serverUrl: member.serverUrl.replace(/\/$/, ""), expiresAt: qr.expiresAt }
}

export async function presentScannedQr(
    raw: string,
    stack: StackDescriptor | null,
    service: UserAppService,
    onWorking: (op: "presentation.create" | null) => void,
    http?: Pick<HttpClient, "postJson">
) {
    const { request, params, serverUrl, expiresAt } = trustedPresentation(raw, stack)
    const present = service.handlers["presentation.create"]
    if (!present) throw new LinkError("UNSUPPORTED_OP", "Presentation is unavailable")
    if (!(await service.consent(request))) throw new Error("The proof was not shared.")
    onWorking("presentation.create")
    try {
        if (Math.floor(Date.now() / 1000) > expiresAt) throw new Error("This challenge has expired. Ask for a new QR.")
        return await present(params, { caller: request.caller })
    } catch (error) {
        // These refusals have already passed the same disclosure gates as the same-phone flow.
        // A denied consent, invalid QR or network failure must not be reported as a rejection.
        if (
            http &&
            error instanceof LinkError &&
            (error.code === "NO_CREDENTIAL" || error.code === "CREDENTIAL_REVOKED")
        ) {
            try {
                await http.postJson(
                    `${serverUrl}/v1/presentation-requests/${encodeURIComponent(params.requestId)}/close`,
                    {
                        code: error.code
                    }
                )
            } catch {
                /* The verifier can still cancel or let the request expire. No automatic retry. */
            }
        }
        throw error
    } finally {
        onWorking(null)
    }
}
