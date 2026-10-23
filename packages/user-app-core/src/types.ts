import type { Hex } from "@coordination-network/identity"
import type { DeviceSigner, Jwk } from "@coordination-network/credential"
import type { ProofGenerator, Store, WalletChainState } from "@coordination-network/wallet"
import type {
    Caller,
    DecodedLinkRequest,
    Hex32,
    Hex65,
    Hex66,
    LinkHandlers,
    LinkOp,
    SecurityLevel
} from "@coordination-network/user-app-link"

/** The text of the system dialog a key use raises. The caller supplies it; the key only shows it. */
export interface KeyPrompt {
    title: string
    subtitle?: string
}

/**
 * The holder's two P-256 hardware keys behind one port: a signing key, used per operation, and an
 * agreement key for ECDH. Every use that unlocks a key takes the prompt the person will see; a
 * cancelled or invalidated key throws `DeviceKeyError`.
 */
export interface DeviceKey {
    getPublicKeyJwk(): Promise<Jwk>
    /** A signer whose `sign` and `signDigest` each raise `prompt`, so it fits `Wallet` and `buildZkPresentationInputs`. */
    signerFor(prompt: KeyPrompt): DeviceSigner
    /** X coordinate of agreementPriv · peerPublicKey, 32 raw bytes. Feeds `deriveEddsaKeypair`. */
    ecdh(peerPublicKey: Uint8Array, prompt: KeyPrompt): Promise<Uint8Array>
    getSecurityLevel(): Promise<SecurityLevel>
    /** Base64 DER certificates attesting the signing key to its hardware root of trust, leaf first; empty when it has none. */
    getAttestationChain(): Promise<string[]>
}

/** A minimal HTTP JSON port: no DOM or RN fetch types needed, and a test fake is three lines. */
export interface HttpJsonResponse {
    status: number
    body: unknown
}

export interface HttpClient {
    getJson(url: string): Promise<HttpJsonResponse>
    postJson(url: string, body: unknown): Promise<HttpJsonResponse>
}

/** One human-readable line of a consent screen, e.g. `{ label: "Programme", value: "demo-programme" }`. */
export interface ConsentDetail {
    label: string
    value: string
    /** Set false for a value whose full text is the point and must never hide behind a tap - the callback. */
    truncate?: boolean
}

/** The programme and country a consent sentence names, on the two ops that scope one. */
export interface ConsentScope {
    programme: string
    country: string
}

interface ConsentSummaryBase {
    caller: Caller
    /** The technical rows the consent sheet folds away, in the order it lists them. */
    details: ConsentDetail[]
}

/**
 * What a request amounts to, in values rather than sentences: the wallet writes every line a
 * person reads, so that it can name the caller mid-sentence in the caller's own colour. Keyed by
 * `op` so a screen that switches on it gets `scope` typed rather than optional.
 */
export type ConsentSummary =
    | (ConsentSummaryBase & { op: "registration.sign" })
    | (ConsentSummaryBase & { op: "credential.issue"; scope: ConsentScope })
    | (ConsentSummaryBase & { op: "presentation.create"; scope: ConsentScope })

/** The single consent gate: shown once per deep link, before dispatch. */
export type UserConsentPrompt = (summary: ConsentSummary) => Promise<boolean>

interface PresentationReviewBase {
    verifier: string
    programme: string
    country: string
    issuerNetworkId: Hex32
}

/**
 * What a verifier would learn. `proof` is what the built proof reveals, which is no longer the
 * issuer: a presentation proves membership of the whole approved set and carries one network-wide
 * revocation root, so nothing in it singles an issuer out. `issuerNetworkId` is still here because
 * the person is shown which of their own credentials answered. `revoked` is the refusal itself:
 * telling a verifier that the person holds a revoked credential says something about them that no
 * proof would have, so it is theirs to allow.
 */
export type PresentationReview =
    (PresentationReviewBase & { kind: "proof" }) | (PresentationReviewBase & { kind: "revoked" })

/**
 * The second gate, on `presentation.create` only: nothing has left the phone yet, so the person
 * can be shown what would. `false` refuses with `CONSENT_DENIED`.
 */
export type PresentationReviewPrompt = (summary: PresentationReview) => Promise<boolean>

/**
 * Whether a held credential has been revoked, from the one registry the whole network writes to.
 * `null` is "nobody to ask": no stack is configured, or it could not be reached. The caller then
 * says it has not checked, rather than calling a credential valid on the strength of its dates.
 */
export interface RevocationAuthority {
    isRevoked(commitment: bigint): Promise<boolean | null>
}

/**
 * What the chain says about a member. A rejection means the chain could not be read, never "no
 * keys": an unknown member answers with an empty list. Unknown includes a removed member and one
 * the wallet's own member list does not have. An implementation must not reveal to the chain node
 * which member is asked about.
 */
export interface MemberDirectory {
    /** Leaves of the member's live issuer keys, as `ApprovedIssuerSet.issuerKeysOf` returns them. */
    issuerKeyLeavesOf(networkId: Hex32): Promise<bigint[]>
}

/**
 * What a served list is checked against. The leaf count pins the issuer set's leaves, not only its
 * root: an internal node can stand in for the leaves under it and keep the root.
 */
export type ChainRoots = Pick<WalletChainState, "approvedIssuerRoot" | "revocationRoot"> & {
    approvedIssuerLeafCount: number
}

/**
 * What the chain holds now: the network's one approved-issuer set and one revocation registry. A
 * rejection means the chain could not be read. The lists a verifier or issuer serves are only
 * bulk data that must hash to exactly these roots, so an implementation must read the chain, never
 * a server, and all three values must come from one chain state (one block). It must not reveal to the chain node which credential or member prompted the read.
 */
export interface RootAuthority {
    currentRoots(): Promise<ChainRoots>
}

export interface UserAppPorts {
    store: Store
    deviceKey: DeviceKey
    /**
     * The lowest level `createIdentity` accepts. Absent means no floor. UNKNOWN ranks with SOFTWARE.
     * The issuer enforces its own minimum at issuance.
     */
    minimumDeviceSecurityLevel?: SecurityLevel
    proofGenerator: ProofGenerator
    http: HttpClient
    consent: UserConsentPrompt
    review: PresentationReviewPrompt
    directory: MemberDirectory
    roots: RootAuthority
    /** Absent leaves every held credential's revocation unchecked; see {@link RevocationAuthority}. */
    revocations?: RevocationAuthority
    /** Named steps inside a long handler, for a screen that shows what the wallet is doing. */
    progress: (op: LinkOp, step: string) => void
    now?: () => number
}

/** What the app's own Identity screen shows; assembled from the device secret, never from a link. */
export interface PublicIdentity {
    networkId: Hex32
    metaStealthAddress: Hex66
    accountPublicKey: Hex65
    securityLevel: SecurityLevel
}

/**
 * What a held credential's state can honestly be called here. The validity window is signed into
 * the credential body, so it is answerable offline. Revocation takes an authority, and there is now
 * exactly one for the whole network — asking it names no issuer, which is what makes this listing
 * able to say "revoked" at all. Issuer approval stays out: an approved-issuer set is still each
 * member's own, so this screen has no one to ask and reports nothing.
 *
 * `unchecked` is a credential inside its window whose revocation could not be established. It is
 * deliberately not folded into `valid`: the difference between "the network says this is live" and
 * "nobody could be asked" is the whole point of showing a status.
 */
export type HeldCredentialStatus = "valid" | "revoked" | "not-yet-valid" | "expired" | "unchecked"

export interface HeldCredential {
    id: string
    /** See {@link HeldCredentialStatus}: the window and revocation, never issuer approval. */
    status: HeldCredentialStatus
    /** The three fields the credential body cannot give back, kept in the issuer index at issuance. */
    issuerNetworkId: Hex32
    programme: string
    issuedAt: number
    /** A one-way hash of {@link programme}, as signed into the credential. */
    programmeHash: string
    /** Unlike `programmeHash`, exactly invertible: `countryCode` just packs three ASCII bytes. */
    country: string
    notBefore: number
    expiresAt: number
}

/**
 * The two keys an app needs to scan ERC-5564 announcements for itself, where there is no indexer.
 * `viewingPrivateKey` is a private key: it detects incoming payments but cannot spend, and it is
 * deliberately the narrowest thing that does the job — far less than the device secret every other
 * key derives from.
 */
export interface StealthScanKeys {
    spendingPublicKey: Hex
    viewingPrivateKey: Hex
}

export interface UserAppService {
    readonly handlers: LinkHandlers
    consent(request: DecodedLinkRequest): Promise<boolean>
    isOnboarded(): Promise<boolean>
    createIdentity(): Promise<PublicIdentity>
    readIdentity(): Promise<PublicIdentity>
    listCredentials(): Promise<HeldCredential[]>
    /** See {@link StealthScanKeys}. Throws if no identity has been created. */
    readStealthScanKeys(): Promise<StealthScanKeys>
    /**
     * Drops every held credential bound to a device key other than the current one, with its
     * revocation secret and issuer-index entry, and resolves to how many. Reads only the public key,
     * so it raises no prompt, and keeps the device secret, so the person stays registered.
     */
    removeUnboundCredentials(): Promise<number>
    erase(): Promise<void>
}
