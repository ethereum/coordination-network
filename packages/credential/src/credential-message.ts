import { Identity } from "@semaphore-protocol/identity"
import { poseidon3 } from "poseidon-lite/poseidon3"
import { poseidon4 } from "poseidon-lite/poseidon4"
import { poseidon5 } from "poseidon-lite/poseidon5"
import { concatHex, hexToBytes, keccak256, stringToHex, toHex } from "viem"
import { bytesToHex } from "@noble/hashes/utils"
import { jwkToPublicKeyBytes } from "./crypto"
import { ApprovalScope, Hex32, Jwk, SerializedZkCredential, ZkCredential, ZkCredentialBody } from "./types"

// keccak256(utf8("urn:cn:credential:v1")) >> 8
export const CREDENTIAL_DOMAIN = 363566488821926773809509531830640889725124777157045803797738936823559174026n
export const ISSUANCE_REQUEST_DOMAIN = "urn:cn:issuance-request:v1"
// Android Key Attestation challenge for the device signing key, as UTF-8 bytes. Fixed because the key is
// attested once, at generation; the device signature over the issuer nonce supplies freshness.
export const DEVICE_ATTESTATION_CHALLENGE = "urn:cn:device-attestation:v1"
export const DEVICE_KEY_DOMAIN = 320507632879070882430325612169297945123468706597652794395401074724051126576n
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
export function stringToField(value: string): bigint {
    return BigInt(keccak256(stringToHex(value))) >> 8n
}

export function programmeHash(programme: string): bigint {
    if (programme.length === 0) throw new Error("programme must not be empty")
    return stringToField(programme)
}

export function countryCode(country: string): number {
    if (!/^[A-Z]{3}$/.test(country)) throw new Error("country must be an ISO 3166-1 alpha-3 code")
    return [...country].reduce((value, character) => (value << 8) | character.charCodeAt(0), 0)
}

/** What the device signature commits to besides the holder key: the issuer and the scope shown at consent. */
export function issuanceRequestCommitment(issuerNetworkId: Hex32, approvalScope: ApprovalScope): Uint8Array {
    if (!/^0x[0-9a-fA-F]{64}$/.test(issuerNetworkId)) throw new Error("issuerNetworkId must be 32 bytes")

    return hexToBytes(
        keccak256(
            concatHex([
                stringToHex(ISSUANCE_REQUEST_DOMAIN),
                issuerNetworkId,
                toHex(programmeHash(approvalScope.programme), { size: 32 }),
                toHex(countryCode(approvalScope.country), { size: 32 })
            ])
        )
    )
}

const bytesToBigint = (value: Uint8Array): bigint => BigInt(`0x${bytesToHex(value)}`)

export function deriveDeviceKeyCommitment(publicKey: Jwk): bigint {
    const encoded = jwkToPublicKeyBytes(publicKey)
    const x = encoded.slice(1, 33)
    const y = encoded.slice(33, 65)

    return poseidon5([
        DEVICE_KEY_DOMAIN,
        bytesToBigint(x.slice(0, 16)),
        bytesToBigint(x.slice(16, 32)),
        bytesToBigint(y.slice(0, 16)),
        bytesToBigint(y.slice(16, 32))
    ])
}

export function zkCredentialCommitment(body: ZkCredentialBody): bigint {
    const policy = poseidon4([
        body.programmeHash,
        BigInt(body.countryCode),
        BigInt(body.notBefore),
        BigInt(body.expiresAt)
    ])
    const keys = poseidon3([body.deviceKeyCommitment, body.holderKeyCommitment, body.revocationCommitment])

    return poseidon3([CREDENTIAL_DOMAIN, policy, keys])
}

const decimal = (value: unknown, name: string): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be decimal`)
    const parsed = BigInt(value)
    if (parsed >= FIELD_MODULUS) throw new Error(`${name} must fit the BN254 field`)
    return parsed
}

const timestamp = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`)
    }
    return value
}

const encodedCountryCode = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffffff) {
        throw new Error("credential.body.countryCode must be a three-byte integer")
    }
    return value
}

const record = (value: unknown, name: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be an object`)
    }
    return value as Record<string, unknown>
}

const exactKeys = (value: Record<string, unknown>, keys: string[], name: string): void => {
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error(`${name} has unexpected fields`)
    }
}

export function serializeZkCredential(credential: ZkCredential): SerializedZkCredential {
    return {
        body: {
            programmeHash: credential.body.programmeHash.toString(),
            countryCode: credential.body.countryCode,
            notBefore: credential.body.notBefore,
            expiresAt: credential.body.expiresAt,
            deviceKeyCommitment: credential.body.deviceKeyCommitment.toString(),
            holderKeyCommitment: credential.body.holderKeyCommitment.toString(),
            revocationCommitment: credential.body.revocationCommitment.toString()
        },
        issuerPublicKey: credential.issuerPublicKey.map(String) as [string, string],
        signature: {
            R8: credential.signature.R8.map(String) as [string, string],
            S: credential.signature.S.toString()
        }
    }
}

export function parseZkCredential(value: unknown): ZkCredential {
    const credential = record(value, "credential")
    exactKeys(credential, ["body", "issuerPublicKey", "signature"], "credential")
    const body = record(credential.body, "credential.body")
    exactKeys(
        body,
        [
            "programmeHash",
            "countryCode",
            "notBefore",
            "expiresAt",
            "deviceKeyCommitment",
            "holderKeyCommitment",
            "revocationCommitment"
        ],
        "credential.body"
    )
    if (!Array.isArray(credential.issuerPublicKey) || credential.issuerPublicKey.length !== 2) {
        throw new Error("credential.issuerPublicKey must contain two values")
    }
    const signature = record(credential.signature, "credential.signature")
    exactKeys(signature, ["R8", "S"], "credential.signature")
    if (!Array.isArray(signature.R8) || signature.R8.length !== 2) {
        throw new Error("credential.signature.R8 must contain two values")
    }

    const parsed: ZkCredential = {
        body: {
            programmeHash: decimal(body.programmeHash, "credential.body.programmeHash"),
            countryCode: encodedCountryCode(body.countryCode),
            notBefore: timestamp(body.notBefore, "credential.body.notBefore"),
            expiresAt: timestamp(body.expiresAt, "credential.body.expiresAt"),
            deviceKeyCommitment: decimal(body.deviceKeyCommitment, "credential.body.deviceKeyCommitment"),
            holderKeyCommitment: decimal(body.holderKeyCommitment, "credential.body.holderKeyCommitment"),
            revocationCommitment: decimal(body.revocationCommitment, "credential.body.revocationCommitment")
        },
        issuerPublicKey: [
            decimal(credential.issuerPublicKey[0], "credential.issuerPublicKey[0]"),
            decimal(credential.issuerPublicKey[1], "credential.issuerPublicKey[1]")
        ],
        signature: {
            R8: [
                decimal(signature.R8[0], "credential.signature.R8[0]"),
                decimal(signature.R8[1], "credential.signature.R8[1]")
            ],
            S: decimal(signature.S, "credential.signature.S")
        }
    }
    if (parsed.body.notBefore >= parsed.body.expiresAt) throw new Error("credential validity window is invalid")
    return parsed
}

export function verifyZkCredential(credential: ZkCredential): boolean {
    try {
        return Identity.verifySignature(
            zkCredentialCommitment(credential.body),
            credential.signature,
            credential.issuerPublicKey
        )
    } catch {
        return false
    }
}
