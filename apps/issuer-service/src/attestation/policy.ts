import { timingSafeEqual } from "node:crypto"
import { DEVICE_ATTESTATION_CHALLENGE } from "@coordination-network/credential"
import type { KeyDescriptionInfo } from "./parse"
import type { AttestedLevel, ChainSecurityLevel, PolicyFailure } from "./types"

const CHALLENGE = Buffer.from(DEVICE_ATTESTATION_CHALLENGE, "utf8")

// KeyMint enum values (hardware/interfaces/security/keymint).
const LEVELS: Record<number, AttestedLevel | undefined> = { 1: "TRUSTED_ENVIRONMENT", 2: "STRONGBOX" }
const ALGORITHM_EC = 3
const CURVE_P_256 = 1
const PURPOSE_SIGN = 2
const PURPOSE_VERIFY = 3
const DIGEST_SHA_256 = 4
const ORIGIN_GENERATED = 0
// HardwareAuthenticatorType PASSWORD | FINGERPRINT: biometric or device credential.
const USER_AUTH_BIOMETRIC_OR_CREDENTIAL = 3
const BOOT_VERIFIED = 0

export type PolicyResult = { ok: true; level: AttestedLevel } | { ok: false; reason: PolicyFailure }

/**
 * Requires a hardware-backed P-256 signing key generated in the keystore, usable only right after
 * the user authenticates, on a locked device that booted verified. Only `hardwareEnforced`
 * satisfies a requirement: `softwareEnforced` is what Android's userspace claims, not the secure
 * hardware. `challenge` is for Google's test chains, which carry their own.
 */
export function checkPolicy(
    description: KeyDescriptionInfo,
    chainLevel: ChainSecurityLevel | undefined,
    challenge: Uint8Array = CHALLENGE
): PolicyResult {
    const refuse = (reason: PolicyFailure): PolicyResult => ({ ok: false, reason })
    const hw = description.hardwareEnforced
    const sw = description.softwareEnforced

    const attested = description.attestationChallenge
    if (attested.length !== challenge.length || !timingSafeEqual(attested, challenge)) {
        return refuse("CHALLENGE_MISMATCH")
    }

    if (description.attestationSecurityLevel !== description.keyMintSecurityLevel) {
        return refuse("SECURITY_LEVEL_MISMATCH")
    }
    const level = LEVELS[description.keyMintSecurityLevel]
    if (!level) return refuse("SOFTWARE_LEVEL")
    // As Google's MATCHES_CERTIFICATE: StrongBox chains always say so, older TEE chains say nothing.
    if (level === "STRONGBOX" ? chainLevel !== "STRONGBOX" : chainLevel !== undefined && chainLevel !== level) {
        return refuse("SECURITY_LEVEL_MISMATCH")
    }

    // Absent from both lists: a per-use key has no AUTH_TIMEOUT at all, so any value, 0 included,
    // means the key stays usable for a while after one authentication.
    if (hw.noAuthRequired || sw.noAuthRequired) return refuse("NO_AUTH_REQUIRED")
    if (hw.authTimeout !== undefined || sw.authTimeout !== undefined) return refuse("AUTH_TIMEOUT")
    if (hw.allowWhileOnBody || sw.allowWhileOnBody) return refuse("ALLOW_WHILE_ON_BODY")
    if (hw.userAuthType !== USER_AUTH_BIOMETRIC_OR_CREDENTIAL) return refuse("USER_AUTH_TYPE")

    if (hw.algorithm !== ALGORITHM_EC || hw.ecCurve !== CURVE_P_256 || hw.keySize !== 256) {
        return refuse("KEY_ALGORITHM")
    }
    const purposes = hw.purpose ?? []
    if (!purposes.includes(PURPOSE_SIGN) || purposes.some((p) => p !== PURPOSE_SIGN && p !== PURPOSE_VERIFY)) {
        return refuse("KEY_PURPOSE")
    }
    if (!hw.digest?.includes(DIGEST_SHA_256)) return refuse("KEY_DIGEST")
    if (hw.origin !== ORIGIN_GENERATED) return refuse("KEY_ORIGIN")

    if (!hw.rootOfTrust) return refuse("ROOT_OF_TRUST_MISSING")
    if (hw.rootOfTrust.verifiedBootState !== BOOT_VERIFIED) return refuse("BOOT_NOT_VERIFIED")
    if (hw.rootOfTrust.deviceLocked !== true) return refuse("DEVICE_UNLOCKED")

    return { ok: true, level }
}
