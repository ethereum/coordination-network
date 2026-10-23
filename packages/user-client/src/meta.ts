import { DerivedKeys, encodeMetaStealthAddress } from "@coordination-network/identity"
import { Hex } from "./types"

/** Encodes a device's spending and viewing keys as its ERC-6538 scheme-1 meta-stealth address. */
export function metaStealthAddressFromKeys(keys: DerivedKeys): Hex {
    return encodeMetaStealthAddress({
        spendingPublicKey: keys.spending.publicKey,
        viewingPublicKey: keys.viewing.publicKey
    })
}

/** Aliased, not reimplemented, so the `st:eth:` prefix lives in one place. */
export { metaStealthAddressUri as displayMetaStealthAddress } from "@coordination-network/identity"
