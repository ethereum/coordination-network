import { Hex } from "../types"
import { META_STEALTH_URI_PREFIX } from "../constants"
import { validateMetaStealthAddress } from "./validateMetaStealthAddress"
import { InvalidMetaStealthAddressError } from "../errors"

/**
 * Splits a 66-byte meta-stealth address (raw hex or `st:eth:` prefixed) into its
 * spending and viewing public keys.
 */
export function decodeMetaStealthAddress(metaStealthAddress: string): {
    spendingPublicKey: Hex
    viewingPublicKey: Hex
} {
    const hexMetaStealthAddress = metaStealthAddress.startsWith(META_STEALTH_URI_PREFIX)
        ? metaStealthAddress.slice(META_STEALTH_URI_PREFIX.length)
        : metaStealthAddress

    if (!validateMetaStealthAddress(hexMetaStealthAddress)) {
        throw new InvalidMetaStealthAddressError()
    }
    const cleanedMetaStealthAddress = hexMetaStealthAddress.slice(2)

    return {
        spendingPublicKey: `0x${cleanedMetaStealthAddress.slice(0, 66)}`,
        viewingPublicKey: `0x${cleanedMetaStealthAddress.slice(66)}`
    }
}
