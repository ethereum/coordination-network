import { poseidon2 } from "poseidon-lite/poseidon2"
import { poseidon3 } from "poseidon-lite/poseidon3"
import { ISSUER_LEAF_DOMAIN } from "./constants"
import type { IssuerPublicKey } from "./types"

/**
 * Commits a Baby Jubjub public key to the leaf value the tree stores for it.
 * Matches `IssuerSetHashes.issuerKeyLeaf` in Solidity (`PoseidonT4`) and the
 * leaf hash in `packages/circuits/src/issuer.nr`; all three must agree or a
 * proof built against one never verifies against a root from another.
 */
export function issuerKeyLeaf(publicKey: IssuerPublicKey): bigint {
    return poseidon3([ISSUER_LEAF_DOMAIN, publicKey[0], publicKey[1]])
}

/** Alias for the name `packages/credential`'s re-export carries forward. */
export const issuerLeaf = issuerKeyLeaf

/** Combines two child nodes into their parent. Matches `IssuerSetHashes.internalNode` (`PoseidonT3`). */
export function internalNode(left: bigint, right: bigint): bigint {
    return poseidon2([left, right])
}
