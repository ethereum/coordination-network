import { randomUUID } from "node:crypto"
import { randomBytes } from "@noble/hashes/utils"

export interface PresentationRequestRecord {
    requestId: string
    /** 31 bytes: matches the circuit's own challenge field width. */
    challenge: Uint8Array
    audience: string
    /** Fixed at creation, not at verify time: this is the value the proof's public input is checked against. */
    currentTime: number
    programme: string
    country: string
    expiresAt: number
    /** The first completed attempt; later replays cannot replace its verdict. */
    verificationId?: string
    completedAt?: number
    cancelled?: boolean
    consumed: boolean
}

export interface CreatePresentationRequestParams {
    audience: string
    programme: string
    country: string
    ttlSeconds: number
}

export interface ConsumeResult {
    record: PresentationRequestRecord
    /** True when an earlier call already consumed this request; the caller must treat this one as a replay. */
    alreadyConsumed: boolean
}

export interface PresentationRequestStore {
    create(params: CreatePresentationRequestParams): Promise<PresentationRequestRecord>
    get(requestId: string): Promise<PresentationRequestRecord | undefined>
    /**
     * Looks up a request and marks it consumed in the same step, so of two callers racing on the
     * same requestId, exactly one gets `alreadyConsumed: false`. Undefined for an unknown id.
     */
    consume(requestId: string): Promise<ConsumeResult | undefined>
    /** Persist only the original attempt's result, never a later replay. */
    complete(request: PresentationRequestRecord, verificationId: string): Promise<void>
    /** Atomically cancel only if no proof has claimed the request. */
    cancel(requestId: string): Promise<"cancelled" | "consumed" | "unknown">
}

export class InMemoryPresentationRequestStore implements PresentationRequestStore {
    private readonly requests = new Map<string, PresentationRequestRecord>()

    constructor(
        private readonly resultTtlSeconds = 86400,
        private readonly now = () => Math.floor(Date.now() / 1000)
    ) {}

    async create({ audience, programme, country, ttlSeconds }: CreatePresentationRequestParams) {
        const now = this.now()
        this.prune(now)

        const record: PresentationRequestRecord = {
            requestId: `urn:uuid:${randomUUID()}`,
            challenge: randomBytes(31),
            audience,
            currentTime: now,
            programme,
            country,
            expiresAt: now + ttlSeconds,
            consumed: false
        }
        this.requests.set(record.requestId, record)
        return record
    }

    async get(requestId: string) {
        return this.requests.get(requestId)
    }

    async consume(requestId: string): Promise<ConsumeResult | undefined> {
        const record = this.requests.get(requestId)
        if (!record) return undefined
        const alreadyConsumed = record.consumed
        record.consumed = true
        return { record, alreadyConsumed }
    }

    async complete(request: PresentationRequestRecord, verificationId: string): Promise<void> {
        // Verification can finish after the challenge expired and was pruned by another create.
        const record = this.requests.get(request.requestId) ?? request
        if (!record.verificationId) {
            record.verificationId = verificationId
            record.completedAt = this.now()
            this.requests.set(record.requestId, record)
        }
    }

    async cancel(requestId: string): Promise<"cancelled" | "consumed" | "unknown"> {
        const record = this.requests.get(requestId)
        if (!record) return "unknown"
        if (record.consumed) return "consumed"
        record.consumed = true
        record.cancelled = true
        return "cancelled"
    }

    /** Keep completed results recoverable for the verification-record TTL, then bound growth. */
    private prune(now: number): void {
        for (const [requestId, record] of this.requests) {
            const retainUntil =
                record.completedAt === undefined ? record.expiresAt : record.completedAt + this.resultTtlSeconds
            if (retainUntil < now) this.requests.delete(requestId)
        }
    }
}
