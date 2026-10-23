/** Fixed NUMS P-256 peer point `Q` for the fifth-key ECDH — see `DERIVATION.md` §12. */

import { hashToCurve, p256 } from "@noble/curves/p256"
import { hexToBytes, utf8ToBytes } from "./bytes"
import { DOMAIN_EDDSA_PEER } from "./constants"

/**
 * NORMATIVE: `Q = hashToCurve(utf8(DOMAIN_EDDSA_PEER))` (RFC 9380
 * `P256_XMD:SHA-256_SSWU_RO_`, suite-default DST). Nobody knows `dlog(Q)`,
 * so `hwPriv · Q` is computable only by the device that holds `hwPriv`.
 * 65-byte SEC1 uncompressed encoding, `0x04`-prefixed.
 */
export const EDDSA_PEER_POINT_HEX =
    "0x045db1cabf31539848bf802ad49a94ad8f8e3d52e75bb53aa4552d7cf836eba054213badca0cf4ba6daf8c146d3415d9ae1905440781dc5f08e6e946a471af99e9" as const

/** Fresh copy of {@link EDDSA_PEER_POINT_HEX} as raw bytes. */
export function eddsaPeerPointBytes(): Uint8Array {
    return hexToBytes(EDDSA_PEER_POINT_HEX)
}

/**
 * Reproduces `Q` from its RFC 9380 provenance, independent of the pinned
 * constant — the evidence that {@link EDDSA_PEER_POINT_HEX} is a NUMS point.
 *
 * `hashToCurve` returns an `H2CPoint`, which lacks `toRawBytes`; round-trip
 * through `ProjectivePoint.fromAffine` to get the SEC1 encoding.
 */
export function computeEddsaPeerPoint(): Uint8Array {
    const point = hashToCurve(utf8ToBytes(DOMAIN_EDDSA_PEER))

    return p256.ProjectivePoint.fromAffine(point.toAffine()).toRawBytes(false)
}
