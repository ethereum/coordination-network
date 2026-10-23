/** Anything that can be coerced to a field element with `BigInt()`. */
export type BigNumberish = bigint | number | string

/** A Baby Jubjub public key in affine form, `[x, y]`. */
export type IssuerPublicKey = [bigint, bigint]

/**
 * A membership proof for one signing key: a Merkle proof of a single leaf.
 * Structurally identical to `packages/credential`'s type of the same name, so
 * a re-export from there type-checks unchanged. `leafIndex` is the leaf's
 * physical slot; `pathIndex` packs the direction bits of the levels actually
 * present in `siblings` (promoted levels have no sibling and are absent), and
 * is what the proof opens against `root` with.
 */
export interface IssuerMembershipProof {
    root: bigint
    leafIndex: number
    pathIndex: number
    siblings: bigint[]
}

/**
 * `ApprovedIssuerSet.generateProof`'s actual return shape: a membership proof
 * plus the per-level direction bits and the leaf itself, together enough to
 * fold to `root` with no other context. `indices` covers only the levels
 * `siblings` includes — `indices[i]` is bit `i` of `pathIndex` — the circuit's
 * `binary_merkle_root` witness.
 */
export interface IssuerMembershipWitness extends IssuerMembershipProof {
    indices: boolean[]
    leaf: bigint
}

/**
 * The structural interface `packages/credential` consumes: a root and a way
 * to prove membership against it. `ApprovedIssuerSet` widens `generateProof`'s
 * return type to {@link IssuerMembershipWitness}, which still satisfies this.
 */
export interface IssuerSet {
    root: bigint
    generateProof(publicKey: IssuerPublicKey): IssuerMembershipProof
}

/**
 * The minimal read surface {@link ApprovedIssuerSet.fromContract} needs from
 * a deployed `ApprovedIssuerSet.sol`. Structural, not a viem `Contract`
 * instance, so this package carries no on-chain dependency.
 */
export interface ContractLeafReader {
    getLeafCount(): Promise<bigint | number>
    getLeaves(start: number, end: number): Promise<(bigint | string | number)[]>
}
