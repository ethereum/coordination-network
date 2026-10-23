import { WalletError, type WalletErrorCode } from "@coordination-network/wallet"
import { LinkError, type LinkErrorCode } from "@coordination-network/user-app-link"

/**
 * A key use the person or the platform ended: cancelled at the prompt, the key invalidated, or the
 * authentication itself failed (lockout, no foreground activity, another prompt already showing).
 */
export class DeviceKeyError extends Error {
    readonly code: "USER_CANCELED" | "KEY_INVALIDATED" | "AUTHENTICATION_FAILED"

    constructor(code: DeviceKeyError["code"], message: string = code) {
        super(message)
        this.name = "DeviceKeyError"
        this.code = code
    }
}

/** A cancel is the person's refusal; anything else the key reports is this app's fault, not a request problem. */
export function mapDeviceKeyError(error: unknown): LinkError {
    if (error instanceof DeviceKeyError && error.code === "USER_CANCELED") {
        return new LinkError("CONSENT_DENIED", "the person cancelled the device prompt")
    }
    return new LinkError("INTERNAL", error instanceof Error ? error.message : String(error))
}

/**
 * `WalletError` and `LinkError` speak different vocabularies for the same underlying failures.
 * Split along one line: a malformed or structurally-invalid credential is `INVALID_REQUEST`;
 * a well-formed credential that is simply not usable right now (not yet valid, expired, its
 * issuer retired) is `NO_CREDENTIAL`, while a revoked one says so outright. A chain-state failure
 * means whichever server published those lists is unreachable or inconsistent, not a fault in
 * this app, hence an unreachable code rather than `INTERNAL`.
 */
const WALLET_ERROR_TO_LINK_ERROR_CODE: Record<WalletErrorCode, LinkErrorCode> = {
    NOT_FOUND: "NO_CREDENTIAL",
    ALREADY_STORED: "INVALID_REQUEST",
    CREDENTIAL_INVALID: "INVALID_REQUEST",
    CONSENT_DENIED: "CONSENT_DENIED",
    REVOKED: "CREDENTIAL_REVOKED",
    CHAIN_STATE_UNAVAILABLE: "VERIFIER_UNREACHABLE",
    CHAIN_STATE_INVALID: "VERIFIER_UNREACHABLE",
    NOT_YET_VALID: "NO_CREDENTIAL",
    EXPIRED: "NO_CREDENTIAL",
    ISSUER_NOT_APPROVED: "NO_CREDENTIAL",
    PRESENTATION_FAILED: "PROOF_FAILED"
}

/**
 * Preserves the original message on the thrown `LinkError`. `chainStateCode` names the side whose
 * lists were being read: during issuance that is the issuer, not a verifier.
 *
 * Takes `unknown` rather than `WalletError` because the wallet's sync methods are not total over
 * `WalletError`: they parse each stored credential and write each record back, so a corrupt record
 * or a failing device store throws something else entirely. Indexing the table with that error's
 * absent `code` would have produced a `LinkError` with no code at all.
 */
export function mapWalletError(error: unknown, chainStateCode?: LinkErrorCode): LinkError {
    // The wallet wraps whatever its signer or seed thunk threw; the key's own failures keep their meaning.
    if (error instanceof WalletError && error.cause instanceof DeviceKeyError) return mapDeviceKeyError(error.cause)
    if (!(error instanceof WalletError)) {
        return new LinkError("INTERNAL", error instanceof Error ? error.message : String(error))
    }
    const isChainState = error.code === "CHAIN_STATE_UNAVAILABLE" || error.code === "CHAIN_STATE_INVALID"
    const code = isChainState && chainStateCode ? chainStateCode : WALLET_ERROR_TO_LINK_ERROR_CODE[error.code]
    return new LinkError(code, error.message)
}
