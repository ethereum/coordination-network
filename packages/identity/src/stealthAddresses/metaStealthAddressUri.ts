import { Hex } from "../types"
import { META_STEALTH_URI_PREFIX } from "../constants"

/** Takes the encoded address, so it also formats one read back from a registry. */
export function metaStealthAddressUri(metaStealthAddress: Hex): string {
    return `${META_STEALTH_URI_PREFIX}${metaStealthAddress}`
}
