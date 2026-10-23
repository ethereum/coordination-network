import { randomBytes } from "@noble/hashes/utils"
import { Hex32 } from "@coordination-network/credential"
import { randomUUID } from "node:crypto"

const NONCE_TTL_MS = 5 * 60_000

export interface Challenge {
    challengeId: string
    subjectNetworkId: Hex32
    nonce: Uint8Array
    expiresAt: number
}

export interface NonceStore {
    issue(subjectNetworkId: Hex32): Promise<Challenge>
    /** Reads without consuming so failed proof validation cannot destroy a valid challenge. */
    get(challengeId: string, subjectNetworkId: Hex32): Promise<Uint8Array | null>
    /** Atomically claims a validated challenge. False means it expired or another request won. */
    consume(challengeId: string, subjectNetworkId: Hex32): Promise<boolean>
}

export class InMemoryNonceStore implements NonceStore {
    private readonly nonces = new Map<string, Challenge>()

    async issue(subjectNetworkId: Hex32): Promise<Challenge> {
        const now = Date.now()
        for (const [id, stored] of this.nonces) {
            if (stored.expiresAt < now) this.nonces.delete(id)
        }
        const challenge = {
            challengeId: randomUUID(),
            subjectNetworkId,
            nonce: randomBytes(32),
            expiresAt: now + NONCE_TTL_MS
        }
        this.nonces.set(challenge.challengeId, challenge)
        return challenge
    }

    async get(challengeId: string, subjectNetworkId: Hex32): Promise<Uint8Array | null> {
        const challenge = this.nonces.get(challengeId)
        if (!challenge || challenge.subjectNetworkId !== subjectNetworkId || challenge.expiresAt < Date.now()) {
            if (challenge?.expiresAt && challenge.expiresAt < Date.now()) this.nonces.delete(challengeId)
            return null
        }
        return challenge.nonce
    }

    async consume(challengeId: string, subjectNetworkId: Hex32): Promise<boolean> {
        const nonce = await this.get(challengeId, subjectNetworkId)
        if (!nonce) return false
        return this.nonces.delete(challengeId)
    }
}
