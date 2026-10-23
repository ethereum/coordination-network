import { Hex } from "../types"
import { assertCompressedPublicKey } from "./assertCompressedPublicKey"

/**
 * The 66-byte compressed spending || viewing concatenation the onchain registry stores. Throws
 * InvalidMetaStealthAddressError, naming the offending key, so it can be used before registering.
 */
export function encodeMetaStealthAddress({
    spendingPublicKey,
    viewingPublicKey
}: {
    spendingPublicKey: Hex
    viewingPublicKey: Hex
}): Hex {
    assertCompressedPublicKey(spendingPublicKey, "spending")
    assertCompressedPublicKey(viewingPublicKey, "viewing")

    return `${spendingPublicKey}${viewingPublicKey.slice(2)}`
}
