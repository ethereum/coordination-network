import { checkPolicy } from "./policy"
import type { PinnedRoot } from "./roots"
import type { StatusListSource, StatusListState } from "./status-list"
import type { AttestationResult } from "./types"
import { verifyChain } from "./verify-chain"

export { GOOGLE_ATTESTATION_ROOTS, type PinnedRoot } from "./roots"
export { createStatusListCache, type StatusListCache, type StatusListSource, type StatusListState } from "./status-list"
export type { AttestationFailure, AttestationResult, AttestedLevel } from "./types"

export interface AttestationVerifier {
    /** `chain` is base64 DER, leaf first; `confirmationKeyXY` the 64-byte P-256 point it must certify. */
    verify(chain: readonly string[], confirmationKeyXY: Uint8Array): AttestationResult
    statusListState(): StatusListState
}

export interface AttestationVerifierDeps {
    roots: readonly PinnedRoot[]
    statusList: StatusListSource
    now?: () => number
}

export function createAttestationVerifier({
    roots,
    statusList,
    now = Date.now
}: AttestationVerifierDeps): AttestationVerifier {
    return {
        verify(chain, confirmationKeyXY) {
            const list = statusList.snapshot()
            if ("unavailable" in list) return { ok: false, reason: "STATUS_LIST_UNAVAILABLE" }
            // The chain is hostile input: anything the checks failed to foresee is a refusal, not a 500.
            try {
                const checked = verifyChain({
                    chain,
                    roots,
                    revokedSerials: list.serials,
                    now: now(),
                    confirmationKeyXY
                })
                return checked.ok ? checkPolicy(checked.description, checked.securityLevel) : checked
            } catch (error) {
                console.warn(`device attestation threw, refused as MALFORMED_CHAIN: ${nameAndFrames(error)}`)
                return { ok: false, reason: "MALFORMED_CHAIN" }
            }
        },
        statusListState() {
            const list = statusList.snapshot()
            return "unavailable" in list ? list.unavailable : "fresh"
        }
    }
}

/** Leaves out the message, which can quote values parsed from the chain, and the stack's copy of it. */
function nameAndFrames(error: unknown): string {
    if (!(error instanceof Error)) return typeof error
    const headerLines = error.message.split("\n").length
    const frames = error.stack?.split("\n").slice(headerLines, headerLines + 3) ?? []
    return [error.name, ...frames.map((frame) => frame.trim())].join(" ")
}
