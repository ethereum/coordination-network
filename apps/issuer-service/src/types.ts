import {
    ApprovalResolver,
    ApprovalScope,
    CredentialSigner,
    Hex32,
    Resolver,
    RevocationWriter
} from "@coordination-network/credential"
import { DeliverToStealthPorts, SubmitRegistrationPorts } from "@coordination-network/network-member-client"
import type { IdentityReader } from "@coordination-network/network-member-client"
import { ActivityLog } from "./activity"
import type { AttestationVerifier } from "./attestation"
import { GovernancePorts } from "./governance-ports"
import { MinimumDeviceSecurityLevel } from "./security-level"
import { IssuerSetBacking } from "./issuer-set"
import { RevocationBacking } from "./revocation"
import type { PeerOrg } from "./status/page"
import { IssuanceStore } from "./stores/issuance-store"
import { NonceStore } from "./stores/nonce-store"
import { PresentationRequestStore } from "./stores/presentation-request-store"
import { VerificationStore } from "./stores/verification-store"
import type { IssuancePolicy } from "./issuance-policy"

export interface IssuanceRecord {
    jti: string
    subjectNetworkId: Hex32
    approvalScope: ApprovalScope
    nbf: number
    exp: number
    /** Poseidon commitment to the device key; the raw JWK is discarded after binding validation. */
    deviceKeyCommitment: string
    revocationCommitment: string
}

export interface AdmissionStatus {
    candidateName: string
    profileUrl?: string
    state: "not-requested" | "pending" | "admitted" | "departed"
    approvals: string[]
    threshold: number
    canRequest: boolean
    canApprove: boolean
    canLeave: boolean
    hasApproved: boolean
    issuerRoot: string
    earlyCompletionBlocked: boolean
    outdatedDecisionBlocked: boolean
}

export interface AdmissionPorts {
    status(): Promise<AdmissionStatus>
    request(): Promise<AdmissionStatus>
    approve(): Promise<AdmissionStatus>
    leave(): Promise<AdmissionStatus>
}

export interface ServerDeps {
    issuerNetworkId: Hex32
    signer: CredentialSigner
    resolver: Resolver & RevocationWriter
    /** Approval reads for the issuance gate. Defaults to resolver; chain-backed in production. */
    approval?: ApprovalResolver
    /** Confirms the credential subject is enrolled. Required by environment-started servers. */
    identityReader?: IdentityReader
    /** Member-owned eligibility decision and authoritative credential scope. */
    issuancePolicy?: IssuancePolicy
    /** Credential validity in seconds from issuance. */
    validitySeconds?: number
    /** Lowest attested device key level `POST /v1/credentials` accepts. Defaults to
     *  TRUSTED_ENVIRONMENT; SOFTWARE skips key attestation altogether. */
    minDeviceSecurityLevel?: MinimumDeviceSecurityLevel
    /** Checks the wallet's key attestation chain. Defaults to Google's roots with a status list
     *  that was never fetched, so issuance answers 503 until one is supplied. */
    deviceAttestation?: AttestationVerifier
    /** Requests per 60s window `POST /v1/challenge` accepts. Defaults to 30. */
    challengesPerMinute?: number
    /** Requests per 60s window `POST /v1/credentials` accepts. Defaults to 30. */
    issuancesPerMinute?: number
    nonceStore?: NonceStore
    issuanceStore?: IssuanceStore
    registration?: SubmitRegistrationPorts
    /** Requests per 60s window `POST /v1/registrations` accepts before answering 429. Defaults to 30. */
    registrationsPerMinute?: number
    delivery?: DeliverToStealthPorts
    /** Requests per 60s window `POST /v1/deliveries` accepts before answering 429. Defaults to 30. */
    deliveriesPerMinute?: number
    /** Requests per 60s window `POST /v1/credentials/:id/revoke` accepts before answering 429. Defaults to 30. */
    revocationsPerMinute?: number
    /** Absent means the Node scenarios' build: the governance routes are not mounted. */
    governance?: GovernancePorts
    /** Defaults to an in-memory mirror (see {@link createInMemoryRevocation}) when absent. */
    revocation?: RevocationBacking
    /** The approved-issuer set this member serves for presentations. Defaults to just this server's own signer key. */
    issuerPublicKeys?: [bigint, bigint][]
    /** Defaults to an in-memory set built from the signer's own key plus `issuerPublicKeys` when absent. */
    issuerSet?: IssuerSetBacking
    verificationStore?: VerificationStore
    /** How long verification outcomes remain readable. Defaults to 24 hours. */
    verificationRecordTtlSeconds?: number
    presentationRequestStore?: PresentationRequestStore
    /** Defaults to the circuit published by `@coordination-network/zk-artifacts`. */
    credentialCircuitPath?: string
    /** How far a presentation request's `currentTime` may drift from this server's clock at verify time. Defaults to 300. */
    verifyMaxSkewSeconds?: number
    /** This server's own identifier, checked as a presentation's `audience` public input. Defaults to `issuerNetworkId`. */
    verifierAudience?: string
    /** How long a `POST /v1/presentation-requests` result stays valid. Defaults to 300. */
    presentationRequestTtlSeconds?: number
    /** Shared with `routes/registrations.ts` at integration, so its writes show up here too.
     *  Defaults to a fresh log when absent. */
    activityLog?: ActivityLog
    /** This member's name on its own status page. Defaults to `issuerNetworkId`. */
    displayName?: string
    /** The stack dashboard's own URL, shown on the status page's links panel when set. */
    dashboardUrl?: string
    /** The other orgs' status pages, shown on the links panel when set. */
    peers?: PeerOrg[]
    /** This org's brand accent, e.g. `#1d4ed8`; sets `--accent` on its own status page. */
    accent?: string
    /** Candidate-admission reads and writes, served to the web demo. Absent means the routes are unmounted. */
    admission?: AdmissionPorts
    /** Bearer token the governance group, the credential listing, the revoke route, and the
     *  registration and delivery routes require. Absent leaves them open, which is what the Node
     *  scenarios and the route tests run with. */
    memberServerToken?: string
    /** Exact browser origins allowed through CORS. Empty leaves every origin alone. */
    allowedOrigins?: string[]
}
