/** Protocol v1 types for the user-app <-> network-member-app deep link. */

/** A `0x`-prefixed lowercase hexadecimal string. Byte-length aliases below are documentation only. */
export type Hex = `0x${string}`

/** A 20-byte address, e.g. `verifyingContract`. */
export type Hex20 = Hex
/** A 31-byte value, sized to fit under the BN254 scalar field for in-circuit use. */
export type Hex31 = Hex
/** A 32-byte value, e.g. a `networkId`. */
export type Hex32 = Hex
/** A 65-byte uncompressed secp256k1 public key, or a 65-byte signature with a recovery byte. */
export type Hex65 = Hex
/** A 66-byte ERC-6538 meta-stealth address (33-byte compressed spending key || 33-byte compressed viewing key). */
export type Hex66 = Hex

/** An EC public key in JWK form (RFC 7517). This protocol uses P-256 only. */
export interface Jwk {
    kty: "EC"
    crv: "P-256"
    x: string
    y: string
}

/** Where the user app's device key lives in the platform's key hierarchy. */
export const SECURITY_LEVELS = ["STRONGBOX", "TRUSTED_ENVIRONMENT", "SOFTWARE", "UNKNOWN"] as const
export type SecurityLevel = (typeof SECURITY_LEVELS)[number]

/** Identifies the member app making a request, as declared by that app (not verified by the OS). */
export interface Caller {
    name: string
    scheme: string
}

export interface ApprovalScope {
    programme: string
    country: string
}

export interface RegistrationSignParams {
    chainId: number
    verifyingContract: Hex20
}

/** Mirrors `RegistrationRequest` from `@coordination-network/user-client`, redeclared to avoid a cross-package dependency. */
export interface SignedRegistrationRequest {
    version: "v1"
    networkId: Hex32
    schemeId: 1
    metaStealthAddress: Hex66
    chainId: number
    verifyingContract: Hex20
    signature: Hex65
}

/**
 * `request` is posted to the member server verbatim. `securityLevel` rides along because
 * registration is the one op every member app runs first, and it is the only thing a member needs
 * about the wallet that the request itself does not already carry.
 */
export interface RegistrationSignResult {
    request: SignedRegistrationRequest
    securityLevel: SecurityLevel
}

/**
 * The wallet drives the whole issuance itself from these four endpoints, so a member app hands
 * over the URLs rather than relaying each hop.
 */
export interface CredentialIssueParams {
    issuerNetworkId: Hex32
    approvalScope: ApprovalScope
    challengeUrl: string
    credentialsUrl: string
    /** The issuer's approved-issuer set, which the wallet checks the credential against before storing. */
    issuersUrl: string
    /** The issuer's revocation snapshot, checked in the same step. */
    revocationsUrl: string
}

/**
 * `refused` is the issuer server declining to issue, in its own error vocabulary — not a
 * {@link LinkErrorCode}. A wallet-side failure throws instead.
 */
export type CredentialIssueResult =
    | { status: "stored"; credentialId: string }
    | { status: "alreadyHeld"; credentialId: string }
    | { status: "refused"; code: string; message: string }

export interface PresentationCreateParams {
    /** From the member server's `POST /v1/presentation-requests`; echoed back in the `/v1/verify` POST. */
    requestId: string
    challenge: Hex31
    audience: string
    currentTime: number
    programme: string
    country: string
    issuersUrl: string
    /** One network-wide tree, so any member serves the same one; the verifier's is the one whose
     *  root it will accept. */
    revocationsUrl: string
    responseUrl: string
}

/** The verifier records the outcome under this id; the caller reads it from its own server. */
export interface PresentationCreateResult {
    verificationId: string
}

/** Every op this protocol version defines, mapped to its params and result shapes. */
export interface LinkOpMap {
    "registration.sign": { params: RegistrationSignParams; result: RegistrationSignResult }
    "credential.issue": { params: CredentialIssueParams; result: CredentialIssueResult }
    "presentation.create": { params: PresentationCreateParams; result: PresentationCreateResult }
}

export const LINK_OPS = [
    "registration.sign",
    "credential.issue",
    "presentation.create"
] as const satisfies readonly (keyof LinkOpMap)[]

export type LinkOp = (typeof LINK_OPS)[number]

export type Params<Op extends LinkOp> = LinkOpMap[Op]["params"]
export type Result<Op extends LinkOp> = LinkOpMap[Op]["result"]

/** Distributive conditional: without it, `LinkRequest` (Op defaulting to `LinkOp`) would let any op pair with any op's params instead of only its own. */
export type LinkRequest<Op extends LinkOp = LinkOp> = Op extends LinkOp
    ? {
          id: string
          version: "v1"
          caller: Caller
          callback: string
          op: Op
          params: Params<Op>
      }
    : never

/** A request whose envelope decoded successfully but whose `op`/`params` are not yet validated against a schema. */
export interface DecodedLinkRequest {
    id: string
    version: "v1"
    caller: Caller
    callback: string
    op: string
    params: unknown
}

export const LINK_ERROR_CODES = [
    "USER_DENIED",
    /** Declined at the share step, after the proof was built and the person saw what it reveals. */
    "CONSENT_DENIED",
    "UNSUPPORTED_OP",
    "INVALID_REQUEST",
    "NOT_ONBOARDED",
    "NO_CREDENTIAL",
    /** A credential for this programme and country is held, but its issuer has revoked it. */
    "CREDENTIAL_REVOKED",
    "PROOF_FAILED",
    "ISSUER_UNREACHABLE",
    "VERIFIER_UNREACHABLE",
    /** The credential's issuer key is not among those the chain lists for the member the caller named. */
    "ISSUER_NOT_APPROVED",
    /** A chain read that would check the issuer keys or the current roots could not be made, so nothing was issued or proved. */
    "CHAIN_UNREACHABLE",
    "INTERNAL"
] as const

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number]

/** The response envelope. Unlike the request, it carries no `op`: the caller already knows which op it asked for. */
export type LinkResponse<Op extends LinkOp = LinkOp> =
    | (Op extends LinkOp ? { id: string; version: "v1"; ok: true; result: Result<Op> } : never)
    | { id: string; version: "v1"; ok: false; code: LinkErrorCode; message?: string }

/** The handlers a user app registers with {@link createRequestHandler}, one per op it supports. */
export type LinkHandlers = {
    [Op in LinkOp]?: (params: Params<Op>, context: { caller: Caller }) => Promise<Result<Op>>
}
