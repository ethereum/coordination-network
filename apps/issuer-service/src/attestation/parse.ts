import { AuthorizationList, KeyMintKeyDescription } from "@peculiar/asn1-android"
import { AsnConvert } from "@peculiar/asn1-schema"

/** The tags the issuer reads. NULL tags are booleans: present or not. */
export interface AuthorizationTags {
    purpose?: number[]
    algorithm?: number
    keySize?: number
    digest?: number[]
    ecCurve?: number
    noAuthRequired: boolean
    userAuthType?: number
    authTimeout?: number
    allowWhileOnBody: boolean
    /** Milliseconds since the epoch. */
    creationDateTime?: number
    origin?: number
    rootOfTrust?: { deviceLocked: boolean; verifiedBootState: number }
}

export interface KeyDescriptionInfo {
    attestationVersion: number
    attestationSecurityLevel: number
    keyMintVersion: number
    keyMintSecurityLevel: number
    attestationChallenge: Uint8Array
    softwareEnforced: AuthorizationTags
    hardwareEnforced: AuthorizationTags
}

/** The schema rejects unknown, duplicate and out-of-order tags. It ignores trailing bytes, extra
 *  fields and non-minimal integers, so the parse must also re-encode to the exact input. */
export function parseKeyDescription(der: ArrayBuffer | Uint8Array): KeyDescriptionInfo {
    const input = Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der))
    const description = AsnConvert.parse(input, KeyMintKeyDescription)
    if (!Buffer.from(AsnConvert.serialize(description)).equals(input)) {
        throw new Error("key description is not canonical DER")
    }
    return {
        attestationVersion: int(description.attestationVersion),
        attestationSecurityLevel: description.attestationSecurityLevel,
        keyMintVersion: int(description.keyMintVersion),
        keyMintSecurityLevel: description.keyMintSecurityLevel,
        attestationChallenge: new Uint8Array(description.attestationChallenge.buffer),
        softwareEnforced: tags(description.softwareEnforced),
        hardwareEnforced: tags(description.hardwareEnforced)
    }
}

// The library hands back an INTEGER of four or more bytes as a decimal string, whatever its type says.
function int(value: number | string): number {
    return typeof value === "number" ? value : Number(BigInt(value))
}

function optionalInt(value: number | string | undefined): number | undefined {
    return value === undefined ? undefined : int(value)
}

function tags(list: AuthorizationList): AuthorizationTags {
    return {
        purpose: list.purpose && Array.from(list.purpose, int),
        algorithm: optionalInt(list.algorithm),
        keySize: optionalInt(list.keySize),
        digest: list.digest && Array.from(list.digest, int),
        ecCurve: optionalInt(list.ecCurve),
        noAuthRequired: list.noAuthRequired !== undefined,
        userAuthType: optionalInt(list.userAuthType),
        authTimeout: optionalInt(list.authTimeout),
        allowWhileOnBody: list.allowWhileOnBody !== undefined,
        creationDateTime: optionalInt(list.creationDateTime),
        origin: optionalInt(list.origin),
        rootOfTrust: list.rootOfTrust && {
            deviceLocked: list.rootOfTrust.deviceLocked,
            verifiedBootState: list.rootOfTrust.verifiedBootState
        }
    }
}
