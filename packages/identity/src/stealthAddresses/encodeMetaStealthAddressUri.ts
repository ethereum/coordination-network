import { Hex } from "../types"
import { encodeMetaStealthAddress } from "./encodeMetaStealthAddress"
import { metaStealthAddressUri } from "./metaStealthAddressUri"

/** The st:eth:0x… display form (ERC-5564 URI). Not stored onchain. */
export function encodeMetaStealthAddressUri(publicKeys: { spendingPublicKey: Hex; viewingPublicKey: Hex }): string {
    return metaStealthAddressUri(encodeMetaStealthAddress(publicKeys))
}
