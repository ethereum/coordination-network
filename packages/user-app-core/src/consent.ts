import type { DecodedLinkRequest, LinkOp, Params } from "@coordination-network/user-app-link"
import type { ConsentSummary } from "./types"

/**
 * `createRequestHandler` calls this after confirming `request.op` is a known op and validating
 * `params` against its schema, so the casts below are re-attaching types the caller already
 * proved, not asserting past them — an exhaustive switch covers every case with no defensive
 * default branch needed. Every value here ends up behind the sheet's "Technical details" toggle;
 * the sentence above it is the app's, not this package's.
 */
export function buildConsentSummary(request: DecodedLinkRequest): ConsentSummary {
    const caller = request.caller
    // The callback is the only signal against a spoofed caller, so it is never shortened.
    const callback = { label: "Callback", value: request.callback, truncate: false }

    switch (request.op as LinkOp) {
        case "registration.sign": {
            const p = request.params as Params<"registration.sign">
            return {
                op: "registration.sign",
                caller,
                details: [
                    callback,
                    // The signature is bound to this contract, so it names what approving commits to.
                    { label: "Registry contract", value: p.verifyingContract },
                    { label: "Chain ID", value: String(p.chainId) }
                ]
            }
        }

        case "credential.issue": {
            const p = request.params as Params<"credential.issue">
            return {
                op: "credential.issue",
                caller,
                scope: { programme: p.approvalScope.programme, country: p.approvalScope.country },
                details: [
                    { label: "Issuer", value: p.issuerNetworkId },
                    // This app posts the binding signatures there itself, so this row is the one
                    // that says where they go. The caller picks the URL, and the schema holds all
                    // four issuance URLs to that one origin, so this row speaks for the rest.
                    { label: "Issuer server", value: p.credentialsUrl },
                    { label: "Programme", value: p.approvalScope.programme },
                    { label: "Country", value: p.approvalScope.country },
                    callback
                ]
            }
        }

        case "presentation.create": {
            const p = request.params as Params<"presentation.create">
            return {
                op: "presentation.create",
                caller,
                scope: { programme: p.programme, country: p.country },
                details: [
                    { label: "Verifier", value: p.audience },
                    // The proof is posted by this app, not handed back to the caller, so this row
                    // is the one that says where it actually goes. Unlike the callback, this URL
                    // is not scheme-restricted, and a caller picks it.
                    { label: "Proof is sent to", value: p.responseUrl },
                    callback,
                    { label: "Programme", value: p.programme },
                    { label: "Country", value: p.country }
                ]
            }
        }
    }
}
