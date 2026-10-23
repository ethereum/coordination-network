export type VerificationFailureCode =
    | "PUBLIC_INPUT_MISMATCH"
    | "PROOF_INVALID"
    | "ISSUER_ROOT_MISMATCH"
    | "REVOCATION_ROOT_INVALID"
    | "STALE_CURRENT_TIME"
    | "EXPIRED_REQUEST"
    | "CONSUMED_REQUEST"

/** Why a wallet refused to present at all, reported by `POST /v1/presentation-requests/:id/close`
 *  instead of by a proof. */
export const PRESENTATION_REFUSAL_CODES = ["CREDENTIAL_REVOKED", "NO_CREDENTIAL"] as const

export type PresentationRefusalCode = (typeof PRESENTATION_REFUSAL_CODES)[number]

export interface VerificationRecord {
    verificationId: string
    ok: boolean
    code?: VerificationFailureCode | PresentationRefusalCode
    /** The presentation request this verification was for. */
    requestId: string
    audience: string
    /** The request's `currentTime`, fixed when `POST /v1/presentation-requests` issued it. */
    currentTime: number
    /** The request's `challenge`, hex-encoded. */
    challenge: string
    programme: string
    country: string
    verifiedAt: number
}

export interface VerificationStore {
    save(record: VerificationRecord): Promise<void>
    get(verificationId: string): Promise<VerificationRecord | undefined>
    delete(verificationId: string): Promise<boolean>
}

export class InMemoryVerificationStore implements VerificationStore {
    private readonly records = new Map<string, VerificationRecord>()

    constructor(
        private readonly ttlSeconds = 86400,
        private readonly now: () => number = () => Math.floor(Date.now() / 1000)
    ) {}

    private prune(): void {
        const cutoff = this.now() - this.ttlSeconds
        for (const [verificationId, record] of this.records) {
            if (record.verifiedAt <= cutoff) this.records.delete(verificationId)
        }
    }

    async save(record: VerificationRecord): Promise<void> {
        this.prune()
        this.records.set(record.verificationId, record)
    }

    async get(verificationId: string): Promise<VerificationRecord | undefined> {
        this.prune()
        return this.records.get(verificationId)
    }

    async delete(verificationId: string): Promise<boolean> {
        return this.records.delete(verificationId)
    }
}
