import { decodeCert, type DecodedCert } from "./certs"
import { parseKeyDescription, type KeyDescriptionInfo } from "./parse"
import type { PinnedRoot } from "./roots"
import type { ChainFailure, ChainSecurityLevel } from "./types"

const MAX_CERTS = 5
const MAX_CERT_BYTES = 16 * 1024
const SERIAL_NUMBER = "2.5.4.5"
const COMMON_NAME = "2.5.4.3"
const ORGANIZATION = "2.5.4.10"
// X‖Y follows this SubjectPublicKeyInfo prefix for an uncompressed P-256 key.
const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex")

export interface ChainInput {
    /** Base64 DER, leaf first, root last. */
    chain: readonly string[]
    roots: readonly PinnedRoot[]
    /** Status-list serials, lowercase hex without leading zeros. */
    revokedSerials: ReadonlySet<string>
    now: number
    confirmationKeyXY: Uint8Array
}

export type ChainResult =
    | {
          ok: true
          provisioning: "rkp" | "factory"
          securityLevel?: ChainSecurityLevel
          /** The leaf's KeyDescription, for the policy to judge. */
          description: KeyDescriptionInfo
      }
    | { ok: false; reason: ChainFailure; certIndex?: number }

/**
 * Mirrors Google's KeyAttestationCertPathValidator, KeyAttestationCertPath and RevocationChecker
 * (github.com/android/keyattestation): older devices' chains are not RFC 5280 paths, so a generic
 * PKIX validator would refuse them, and `checkIssued` does too.
 */
export function verifyChain({ chain, roots, revokedSerials, now, confirmationKeyXY }: ChainInput): ChainResult {
    if (chain.length === 0 || chain.length > MAX_CERTS) return { ok: false, reason: "CHAIN_SIZE" }
    const certs: DecodedCert[] = []
    for (const [certIndex, b64] of chain.entries()) {
        const der = Buffer.from(b64, "base64")
        if (der.length > MAX_CERT_BYTES) return { ok: false, reason: "CHAIN_SIZE", certIndex }
        try {
            certs.push(decodeCert(der))
        } catch {
            return { ok: false, reason: "CERT_MALFORMED", certIndex }
        }
    }

    const last = certs.length - 1
    const root = pinnedRoot(certs[last], roots)
    if (!root) return { ok: false, reason: "UNTRUSTED_ROOT", certIndex: last }
    if (certs.length < 4) return { ok: false, reason: "CHAIN_SIZE" }

    const intermediate = certs[last - 1].subject
    let provisioning: "rkp" | "factory"
    if (intermediate.has(SERIAL_NUMBER)) {
        provisioning = "factory"
        if (certs.length !== 4 || !root.factory) return { ok: false, reason: "PROVISIONING_MISMATCH" }
    } else if (only(intermediate, COMMON_NAME) === "Droid CA2" && only(intermediate, ORGANIZATION) === "Google LLC") {
        provisioning = "rkp"
        if (certs.length !== 5) return { ok: false, reason: "PROVISIONING_MISMATCH" }
    } else {
        return { ok: false, reason: "UNKNOWN_PROVISIONING" }
    }

    for (let certIndex = last - 1; certIndex >= 0; certIndex--) {
        const cert = certs[certIndex].x509
        const issuer = certs[certIndex + 1].x509
        if (cert.issuer !== issuer.subject) return { ok: false, reason: "NAME_CHAINING", certIndex }
        if (!verifies(cert, issuer)) return { ok: false, reason: "INVALID_SIGNATURE", certIndex }
    }

    for (const [certIndex, { serialHex }] of certs.entries()) {
        if (revokedSerials.has(serialHex)) return { ok: false, reason: "CERT_REVOKED", certIndex }
    }

    // A key description anywhere but the leaf means someone hung their own cert below an
    // attested key, to vouch for a key that never saw the keystore.
    if (certs[0].keyDescriptions.length === 0) return { ok: false, reason: "EXTENSION_MISSING", certIndex: 0 }
    for (const [certIndex, { keyDescriptions }] of certs.entries()) {
        if (keyDescriptions.length > (certIndex === 0 ? 1 : 0)) {
            return { ok: false, reason: "EXTENSION_MISPLACED", certIndex }
        }
    }

    const leafSpki = certs[0].x509.publicKey.export({ type: "spki", format: "der" })
    if (!leafSpki.equals(Buffer.concat([P256_SPKI_PREFIX, Buffer.from([4]), confirmationKeyXY]))) {
        return { ok: false, reason: "LEAF_KEY_MISMATCH", certIndex: 0 }
    }

    let description: KeyDescriptionInfo
    try {
        description = parseKeyDescription(certs[0].keyDescriptions[0])
    } catch {
        return { ok: false, reason: "KEY_DESCRIPTION_MALFORMED", certIndex: 0 }
    }

    // Android attests a key only when it is made and the wallet resends that chain, while RKP certs
    // expire within days. So an RKP intermediate must not have expired before min(created, now): the
    // creation time is the phone's own claim from Android userspace, and a clock that is off must not
    // refuse a fresh chain. Back-dating it takes userspace control on a locked device that kept an old
    // attestation key, or a leaked RKP attestation key, and passes until Google revokes it. Factory keys
    // cannot be rotated, so their expired intermediates stay valid. Leaf dates are set on the device and
    // the root is trusted by key alone: neither is checked.
    const expiredBy = Math.min(description.softwareEnforced.creationDateTime ?? now, now)
    for (let certIndex = last - 1; certIndex >= 1; certIndex--) {
        const { notBefore, notAfter } = certs[certIndex].asn.tbsCertificate.validity
        if (now < notBefore.getTime().getTime()) return { ok: false, reason: "CERT_NOT_YET_VALID", certIndex }
        if (expiredBy > notAfter.getTime().getTime() && provisioning === "rkp") {
            return { ok: false, reason: "CERT_EXPIRED", certIndex }
        }
    }

    return {
        ok: true,
        provisioning,
        securityLevel: provisioning === "rkp" ? rkpLevel(certs[1]) : factoryLevel(certs[1], certs[last - 1]),
        description
    }
}

function pinnedRoot({ x509 }: DecodedCert, roots: readonly PinnedRoot[]): PinnedRoot | undefined {
    let spki: Buffer
    try {
        spki = x509.publicKey.export({ type: "spki", format: "der" })
    } catch {
        // Decoding a certificate leaves its key unread; OpenSSL throws here on an algorithm it cannot load.
        return undefined
    }
    return roots.find((root) => spki.equals(root.spki))
}

function only(subject: DecodedCert["subject"], oid: string): string | undefined {
    const values = subject.get(oid)
    return values?.length === 1 ? values[0] : undefined
}

function verifies(cert: DecodedCert["x509"], issuer: DecodedCert["x509"]): boolean {
    try {
        return cert.verify(issuer.publicKey)
    } catch {
        // OpenSSL throws rather than answering false when the key cannot check this signature type.
        return false
    }
}

/** An RKP attestation cert names its level in O. */
function rkpLevel(attestation: DecodedCert): ChainSecurityLevel {
    switch (only(attestation.subject, ORGANIZATION)) {
        case "TEE":
            return "TRUSTED_ENVIRONMENT"
        case "StrongBox":
            return "STRONGBOX"
        default:
            return "SOFTWARE"
    }
}

/** Only StrongBox factory chains say so, somewhere in a subject; Android's CTS checks it this way. */
function factoryLevel(...certs: DecodedCert[]): ChainSecurityLevel | undefined {
    const strongBox = certs.some(({ subject }) =>
        [...subject.values()].flat().some((value) => value.toLowerCase().includes("strongbox"))
    )
    return strongBox ? "STRONGBOX" : undefined
}
