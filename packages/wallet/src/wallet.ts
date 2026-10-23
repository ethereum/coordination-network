import { Identity } from "@semaphore-protocol/identity"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { deriveKeys, normalizeDeviceSecret, type DerivedKeys, type Hex } from "@coordination-network/identity"
import {
    buildZkPresentationInputs,
    deriveDeviceKeyCommitment,
    deriveRevocationCommitment,
    parseZkCredential,
    serializeZkCredential,
    verifyZkCredential,
    type DeviceSigner,
    type SerializedZkCredential,
    type ZkPresentationInputs,
    type ZkPresentationProof,
    type ZkPresentationRequest
} from "@coordination-network/credential"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { WalletError } from "./errors"
import { MemoryStore, type Store } from "./store"

export const KEY_PREFIX = "key:"
export const CREDENTIAL_PREFIX = "vc:"

/** Stored apart from its credential, under its own prefix, so a `Store` can route it differently. */
export const REVOCATION_SECRET_PREFIX = "revsec:"

/** How often background sync restamps held credentials (issue #47 asks for 60s or better). */
export const SYNC_INTERVAL_MS = 30_000

export type CredentialStatus = "valid" | "revoked" | "not-yet-valid" | "expired" | "issuer-not-approved"

export interface ConsentRequest {
    kind: "present" | "prove-ownership"
    credentialId: string
    audience: string
    programme: string
    country: string
}

/** True allows the proof to be built; anything else stops it before any presentation signature. */
export type ConsentPrompt = (request: ConsentRequest) => Promise<boolean>

export interface WalletChainState {
    approvedIssuers: ApprovedIssuerSet
    /** Authoritative root, read from chain by the caller, never from the server that served the leaves. */
    approvedIssuerRoot: bigint
    revocations: RevocationRegistry
    /** Authoritative root, read from chain by the caller, never from the server that served the snapshot. */
    revocationRoot: bigint
}

/** Fetches and validates the latest public issuer and revocation trees. */
export type ChainStateLoader = () => Promise<WalletChainState>

/** ZkCredentialProofSystem satisfies this without making the wallet own its lifecycle. */
export interface ProofGenerator {
    generateProof(inputs: ZkPresentationInputs): Promise<ZkPresentationProof>
}

export interface CredentialInfo {
    id: string
    credential: SerializedZkCredential
    status: CredentialStatus
    /** When the public issuer and revocation trees were last refreshed, in milliseconds since epoch. */
    checkedAt: number
}

interface CredentialRecord {
    credential: SerializedZkCredential
    revoked: boolean
    issuerApproved: boolean
    checkedAt: number
}

export interface WalletOptions {
    /**
     * Raw 32-byte Semaphore identity seed derived from the hardware P-256 ECDH output. A thunk is
     * called once per `addCredential` and `present`, so a device key can prompt only when needed.
     */
    identitySeed: Uint8Array | (() => Promise<Uint8Array>)
    deviceSigner: DeviceSigner
    consent: ConsentPrompt
    loadChainState: ChainStateLoader
    proofGenerator: ProofGenerator
    /** Defaults to memory; on device, use a keystore-backed implementation. */
    store?: Store
    /** Injectable clock for deterministic tests. Returns milliseconds since epoch. */
    now?: () => number
    /** Receives background-sync failures instead of creating unhandled promise rejections. */
    onSyncError?: (error: unknown) => void
}

/** Match the verifier's default freshness window before a caller-chosen time reaches the prover. */
const MAX_PRESENTATION_TIME_SKEW_SECONDS = 300

export interface AddCredentialOptions {
    id: string
    /** Whatever the issuer sent: `addCredential` parses and verifies it, and stores that. */
    credential: unknown
    /** Raw 32-byte secret whose Semaphore commitment is signed into this credential. */
    revocationSecret: Uint8Array
}

/** Device keys and held ZK credentials, with consent and fresh public tree state around presentation. */
export class Wallet {
    private readonly store: Store
    private readonly identitySeed: Uint8Array | (() => Promise<Uint8Array>)
    private readonly deviceSigner: DeviceSigner
    private readonly consent: ConsentPrompt
    private readonly loadChainState: ChainStateLoader
    private readonly proofGenerator: ProofGenerator
    private readonly now: () => number
    private readonly onSyncError: (error: unknown) => void

    constructor(options: WalletOptions) {
        if (typeof options.identitySeed !== "function" && options.identitySeed.length !== 32) {
            throw new Error("identity seed must be exactly 32 bytes")
        }
        this.store = options.store ?? new MemoryStore()
        this.identitySeed =
            typeof options.identitySeed === "function" ? options.identitySeed : options.identitySeed.slice()
        this.deviceSigner = options.deviceSigner
        this.consent = options.consent
        this.loadChainState = options.loadChainState
        this.proofGenerator = options.proofGenerator
        this.now = options.now ?? Date.now
        this.onSyncError = options.onSyncError ?? (() => {})
    }

    /** Derives a device secret from high-entropy seed material. Do not pass a human-memorable password. */
    async createFromSeed(seed: Uint8Array): Promise<Hex> {
        if (seed.length === 0) throw new Error("seed must not be empty")
        return this.importKey(sha256(seed))
    }

    /** The networkId falls out of the secret, so re-importing overwrites rather than duplicates. */
    async importKey(secret: Uint8Array | Hex): Promise<Hex> {
        const bytes = normalizeDeviceSecret(secret)
        const { networkId } = deriveKeys(bytes)
        await this.store.set(`${KEY_PREFIX}${networkId}`, `0x${bytesToHex(bytes)}`)
        return networkId
    }

    async listKeys(): Promise<Hex[]> {
        return (await this.store.list())
            .filter((key) => key.startsWith(KEY_PREFIX))
            .map((key) => key.slice(KEY_PREFIX.length) as Hex)
    }

    async getKey(networkId: Hex): Promise<DerivedKeys | null> {
        const secret = await this.store.get(`${KEY_PREFIX}${networkId}`)
        return secret === null ? null : deriveKeys(secret as Hex)
    }

    async deleteKey(networkId: Hex): Promise<void> {
        await this.store.delete(`${KEY_PREFIX}${networkId}`)
    }

    /** Verifies the signed body, all three holder bindings, issuer membership and revocation before storing. */
    async addCredential(options: AddCredentialOptions): Promise<string> {
        if (options.id.trim().length === 0) throw new WalletError("CREDENTIAL_INVALID", "credential id is empty")
        if (options.revocationSecret.length !== 32) {
            throw new WalletError("CREDENTIAL_INVALID", "revocation secret must be exactly 32 bytes")
        }

        try {
            const credential = parseZkCredential(options.credential)
            if (!verifyZkCredential(credential)) throw new Error("credential issuer signature is invalid")
            if (new Identity(await this.resolveIdentitySeed()).commitment !== credential.body.holderKeyCommitment) {
                throw new Error("identity seed does not open the credential holder commitment")
            }
            if (deriveRevocationCommitment(options.revocationSecret) !== credential.body.revocationCommitment) {
                throw new Error("revocation secret does not open the credential revocation commitment")
            }
            if (
                deriveDeviceKeyCommitment(await this.deviceSigner.getPublicKeyJwk()) !==
                credential.body.deviceKeyCommitment
            ) {
                throw new Error("device signer does not open the credential device commitment")
            }

            const chainState = await this.loadAndValidateChainState()
            if (!chainState.approvedIssuers.isApproved(credential.issuerPublicKey)) {
                throw new Error("credential issuer is not in the approved set")
            }
            if (chainState.revocations.isRevoked(credential.body.revocationCommitment)) {
                throw new WalletError("REVOKED", `credential ${options.id} has been revoked`)
            }

            const nowSeconds = Math.floor(this.now() / 1000)
            if (nowSeconds < credential.body.notBefore) {
                throw new WalletError("NOT_YET_VALID", `credential ${options.id} is not yet valid`)
            }
            if (nowSeconds > credential.body.expiresAt) {
                throw new WalletError("EXPIRED", `credential ${options.id} has expired`)
            }
            if ((await this.readRecord(options.id)) !== null) {
                throw new WalletError("ALREADY_STORED", `credential ${options.id} is already stored`)
            }

            await this.store.set(
                `${REVOCATION_SECRET_PREFIX}${options.id}`,
                `0x${bytesToHex(options.revocationSecret)}`
            )
            await this.writeRecord(options.id, {
                credential: serializeZkCredential(credential),
                revoked: false,
                issuerApproved: true,
                checkedAt: this.now()
            })
            return options.id
        } catch (error) {
            if (error instanceof WalletError) throw error
            throw new WalletError(
                "CREDENTIAL_INVALID",
                error instanceof Error ? error.message : "credential verification failed",
                error
            )
        }
    }

    async listCredentials(): Promise<CredentialInfo[]> {
        const infos = await Promise.all((await this.listCredentialIds()).map((id) => this.getCredential(id)))
        return infos.filter((info): info is CredentialInfo => info !== null)
    }

    async getCredential(id: string): Promise<CredentialInfo | null> {
        const record = await this.readRecord(id)
        if (record === null) return null
        return { id, credential: record.credential, status: this.statusOf(record), checkedAt: record.checkedAt }
    }

    async deleteCredential(id: string): Promise<void> {
        await this.store.delete(`${CREDENTIAL_PREFIX}${id}`)
        await this.store.delete(`${REVOCATION_SECRET_PREFIX}${id}`)
    }

    async present(id: string, request: ZkPresentationRequest, load: ChainStateLoader): Promise<ZkPresentationProof> {
        return this.buildPresentation(id, "present", request, load)
    }

    async proveOwnership(
        id: string,
        request: ZkPresentationRequest,
        load: ChainStateLoader
    ): Promise<ZkPresentationProof> {
        return this.buildPresentation(id, "prove-ownership", request, load)
    }

    private async buildPresentation(
        id: string,
        kind: ConsentRequest["kind"],
        request: ZkPresentationRequest,
        load: ChainStateLoader
    ): Promise<ZkPresentationProof> {
        const record = await this.readRecord(id)
        if (record === null) throw new WalletError("NOT_FOUND", `no credential stored under ${id}`)

        const revocationSecret = await this.store.get(`${REVOCATION_SECRET_PREFIX}${id}`)
        if (revocationSecret === null) {
            throw new WalletError("NOT_FOUND", `no revocation secret stored for credential ${id}`)
        }

        // One read decides both what the proof names as issuer and which tree it is checked
        // against. Reading them apart was only ever correct by call order.
        const chainState = await this.loadAndValidateChainState(load)
        this.stamp(record, chainState, this.now())
        await this.writeRecord(id, record)

        const status = this.statusOf(record)
        if (status === "revoked") throw new WalletError("REVOKED", `credential ${id} has been revoked`)
        if (status === "not-yet-valid") throw new WalletError("NOT_YET_VALID", `credential ${id} is not yet valid`)
        if (status === "expired") throw new WalletError("EXPIRED", `credential ${id} has expired`)
        if (status === "issuer-not-approved") {
            throw new WalletError("ISSUER_NOT_APPROVED", `credential ${id}'s issuer is no longer approved`)
        }

        const nowSeconds = Math.floor(this.now() / 1000)
        if (
            !Number.isSafeInteger(request.currentTime) ||
            Math.abs(request.currentTime - nowSeconds) > MAX_PRESENTATION_TIME_SKEW_SECONDS
        ) {
            throw new WalletError("PRESENTATION_FAILED", "presentation request time is not current")
        }

        const allowed = await this.consent({
            kind,
            credentialId: id,
            audience: request.audience,
            programme: request.programme,
            country: request.country
        })
        if (!allowed) throw new WalletError("CONSENT_DENIED", "the user declined this presentation")

        let inputs: ZkPresentationInputs
        try {
            inputs = await buildZkPresentationInputs(
                record.credential,
                {
                    identitySeed: await this.resolveIdentitySeed(),
                    revocationSecret: hexToBytes(revocationSecret.slice(2)),
                    deviceSigner: this.deviceSigner
                },
                {
                    // The whole approved set, so the proof's issuer root is the set's root and
                    // names no issuer. One network-wide revocation registry is what allows this:
                    // the verifier checks the revocation root without having to pick a registry,
                    // and picking one was what gave the issuer away.
                    approvedIssuers: chainState.approvedIssuers,
                    revocations: chainState.revocations
                },
                request
            )
        } catch (error) {
            if (error instanceof WalletError) throw error
            throw new WalletError(
                "PRESENTATION_FAILED",
                error instanceof Error ? error.message : "failed to build presentation inputs",
                error
            )
        }
        return this.proofGenerator.generateProof(inputs)
    }

    /** Refreshes both public trees once, then updates every held credential without a per-credential RPC lookup. */
    async syncRevocations(): Promise<void> {
        const chainState = await this.loadAndValidateChainState()
        const checkedAt = this.now()

        for (const id of await this.listCredentialIds()) {
            const record = await this.readRecord(id)
            if (record === null) continue
            this.stamp(record, chainState, checkedAt)
            await this.writeRecord(id, record)
        }
    }

    /**
     * Refreshes one credential against the state `load` reads. The caller supplies that state
     * rather than the wallet fetching it, so a request checking several credentials reads once and
     * every one of them is judged against the same network state.
     */
    async syncCredential(id: string, load: ChainStateLoader): Promise<void> {
        const record = await this.readRecord(id)
        if (record === null) throw new WalletError("NOT_FOUND", `no credential stored under ${id}`)

        const chainState = await this.loadAndValidateChainState(load)
        this.stamp(record, chainState, this.now())
        await this.writeRecord(id, record)
    }

    /** Starts background status refresh and returns its stop function. */
    startRevocationSync(intervalMs: number = SYNC_INTERVAL_MS): () => void {
        const timer = setInterval(() => {
            void this.syncRevocations().catch(this.onSyncError)
        }, intervalMs)
        return () => clearInterval(timer)
    }

    private stamp(record: CredentialRecord, chainState: WalletChainState, checkedAt: number): void {
        const credential = parseZkCredential(record.credential)
        record.revoked = chainState.revocations.isRevoked(credential.body.revocationCommitment)
        record.issuerApproved = chainState.approvedIssuers.isApproved(credential.issuerPublicKey)
        record.checkedAt = checkedAt
    }

    private statusOf(record: CredentialRecord): CredentialStatus {
        if (record.revoked) return "revoked"
        if (!record.issuerApproved) return "issuer-not-approved"
        const nowSeconds = Math.floor(this.now() / 1000)
        const { body } = parseZkCredential(record.credential)
        if (nowSeconds < body.notBefore) return "not-yet-valid"
        if (nowSeconds > body.expiresAt) return "expired"
        return "valid"
    }

    private async loadAndValidateChainState(load: ChainStateLoader = this.loadChainState): Promise<WalletChainState> {
        let chainState: WalletChainState
        try {
            chainState = await load()
        } catch (error) {
            throw new WalletError(
                "CHAIN_STATE_UNAVAILABLE",
                error instanceof Error ? error.message : "failed to load chain state"
            )
        }
        if (chainState.approvedIssuers.root !== chainState.approvedIssuerRoot) {
            throw new WalletError("CHAIN_STATE_INVALID", "approved issuer tree does not match its authoritative root")
        }
        if (chainState.revocations.root !== chainState.revocationRoot) {
            throw new WalletError("CHAIN_STATE_INVALID", "revocation tree does not match its authoritative root")
        }
        return chainState
    }

    private async resolveIdentitySeed(): Promise<Uint8Array> {
        if (typeof this.identitySeed !== "function") return this.identitySeed
        const seed = await this.identitySeed()
        if (seed.length !== 32) throw new Error("identity seed must be exactly 32 bytes")
        return seed
    }

    private async listCredentialIds(): Promise<string[]> {
        return (await this.store.list())
            .filter((key) => key.startsWith(CREDENTIAL_PREFIX))
            .map((key) => key.slice(CREDENTIAL_PREFIX.length))
    }

    private async readRecord(id: string): Promise<CredentialRecord | null> {
        const raw = await this.store.get(`${CREDENTIAL_PREFIX}${id}`)
        return raw === null ? null : (JSON.parse(raw) as CredentialRecord)
    }

    private async writeRecord(id: string, record: CredentialRecord): Promise<void> {
        await this.store.set(`${CREDENTIAL_PREFIX}${id}`, JSON.stringify(record))
    }
}
