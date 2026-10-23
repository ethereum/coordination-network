/**
 * The BN254 (alt_bn128) scalar field order. Every leaf and internal-node hash,
 * and every signing-key coordinate, is an element of this field.
 */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/**
 * Baby Jubjub's cofactor. A point has low order exactly when multiplying it by
 * this gives the identity, which is what disqualifies a signing key: see
 * `toPublicKey`.
 */
export const COFACTOR = 8n

/**
 * The tree's capacity bound: spec 03's construction and the circuit's
 * `binary_merkle_root`. The tree's actual depth is dynamic; see
 * `ApprovedIssuerSet.depth`.
 */
export const ISSUER_SET_MAX_DEPTH = 20

/**
 * Domain separator mixed into every leaf commitment, matching
 * `IssuerSetHashes.ISSUER_LEAF_DOMAIN` in Solidity and `LEAF_DOMAIN` in the
 * circuit.
 */
export const ISSUER_LEAF_DOMAIN = 185404551131306766954100762329350135288498146007932686448214248919067924295n
