import { Hex32, Jwk } from "./types"

/**
 * Pluggable resolution of urn:cn: identifiers to registry state (spec 07,
 * trust model). In-memory for now; registry contracts back a chain
 * implementation later.
 */
export interface Resolver {
    isApprovedNetworkMember(id: Hex32): Promise<boolean>
    getCredentialPublicKey(id: Hex32): Promise<Jwk | null>
    isRevoked(commitment: bigint): Promise<boolean>
}

/** The approval half of Resolver — all issuance needs, and all the chain-backed registry client provides. */
export type ApprovalResolver = Pick<Resolver, "isApprovedNetworkMember">

/**
 * Write side of the revocation registry. Separate from Resolver because
 * verifiers never hold it.
 */
export interface RevocationWriter {
    revoke(commitment: bigint): Promise<void>
}

/**
 * In-memory registry state for tests and the demo issuer service. The seed
 * methods stand in for the one-time on-chain writes (member admission, key
 * publication); the async interface methods mirror the chain reads.
 */
export class InMemoryResolver implements Resolver, RevocationWriter {
    private readonly approved = new Set<Hex32>()
    private readonly credentialKeys = new Map<Hex32, Jwk>()
    private readonly revoked = new Set<string>()

    approveMember(id: Hex32): void {
        this.approved.add(id)
    }

    removeMember(id: Hex32): void {
        this.approved.delete(id)
    }

    setCredentialPublicKey(id: Hex32, jwk: Jwk): void {
        this.credentialKeys.set(id, jwk)
    }

    async isApprovedNetworkMember(id: Hex32): Promise<boolean> {
        return this.approved.has(id)
    }

    async getCredentialPublicKey(id: Hex32): Promise<Jwk | null> {
        return this.credentialKeys.get(id) ?? null
    }

    async isRevoked(commitment: bigint): Promise<boolean> {
        return this.revoked.has(commitment.toString())
    }

    async revoke(commitment: bigint): Promise<void> {
        this.revoked.add(commitment.toString())
    }
}
