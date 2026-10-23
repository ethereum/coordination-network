/** Credential and issuance types. */

/** A 32-byte value as a 0x-prefixed hex string (e.g. a networkId). */
export type Hex32 = `0x${string}`

/** An EC public key in JWK form (RFC 7517). This profile uses P-256 only. */
export interface Jwk {
    kty: "EC"
    crv: "P-256"
    x: string
    y: string
}

export interface ApprovalScope {
    /** Programme the approval covers. */
    programme: string
    /** ISO 3166-1 alpha-3 country code. */
    country: string
}

/** Baby Jubjub EdDSA public key, shaped as Semaphore V4 exposes it. */
export type EddsaPublicKey = [bigint, bigint]

/** Baby Jubjub EdDSA signature, shaped as Semaphore V4 exposes it. */
export interface EddsaSignature {
    R8: [bigint, bigint]
    S: bigint
}

export interface IssuanceRequest {
    issuerNetworkId: Hex32
    subjectNetworkId: Hex32
    approvalScope: ApprovalScope
    validFrom: number
    validUntil: number
    confirmationKey: Jwk
    accountPublicKey: Uint8Array
    nonce: Uint8Array
    devicePopSignature: Uint8Array
    accountPopSignature: Uint8Array
    revocation: {
        commitment: bigint
        publicKey: EddsaPublicKey
        ownershipSignature: EddsaSignature
    }
}

export interface ZkCredentialIssueParams extends IssuanceRequest {
    identityPublicKey: EddsaPublicKey
    /** Signature over the issuer challenge proving control of `identityPublicKey`. */
    identityOwnershipSignature: EddsaSignature
}

export interface ZkCredentialBody {
    programmeHash: bigint
    countryCode: number
    notBefore: number
    expiresAt: number
    deviceKeyCommitment: bigint
    holderKeyCommitment: bigint
    revocationCommitment: bigint
}

export interface ZkCredential {
    body: ZkCredentialBody
    issuerPublicKey: EddsaPublicKey
    signature: EddsaSignature
}

export interface SerializedZkCredential {
    body: {
        programmeHash: string
        countryCode: number
        notBefore: number
        expiresAt: number
        deviceKeyCommitment: string
        holderKeyCommitment: string
        revocationCommitment: string
    }
    issuerPublicKey: [string, string]
    signature: { R8: [string, string]; S: string }
}
