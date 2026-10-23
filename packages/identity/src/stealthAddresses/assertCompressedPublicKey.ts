import { secp256k1 } from "@noble/curves/secp256k1"
import { Hex } from "../types"
import { COMPRESSED_PUBLIC_KEY_LENGTH } from "../constants"
import { InvalidMetaStealthAddressError } from "../errors"

/** Checked per key, not on the concatenation: 32 + 34 bytes hits the right total but splits wrong. */
export function assertCompressedPublicKey(publicKey: Hex, label: string): void {
    if (!/^0x[0-9a-fA-F]+$/.test(publicKey) || (publicKey.length - 2) / 2 !== COMPRESSED_PUBLIC_KEY_LENGTH) {
        throw new InvalidMetaStealthAddressError(
            // Never echo the value: a 32-byte private key passed here by mistake lands on this branch.
            `${label} public key must be ${COMPRESSED_PUBLIC_KEY_LENGTH} bytes of SEC1-compressed hex`
        )
    }

    const prefix = publicKey.slice(2, 4)
    if (prefix !== "02" && prefix !== "03") {
        throw new InvalidMetaStealthAddressError(`${label} public key must start with 0x02 or 0x03, got 0x${prefix}`)
    }

    try {
        secp256k1.Point.fromHex(publicKey.slice(2))
    } catch {
        throw new InvalidMetaStealthAddressError(`${label} public key is not a point on secp256k1`)
    }
}
