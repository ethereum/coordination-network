import { deriveKeys, encodeMetaStealthAddress, generateDeviceSecret, type Hex } from "@coordination-network/identity"

/** Step 1, receiver. Derive keys and encode meta stealth address */
export function generateMetaStealthAddress(deviceSecret: Hex = generateDeviceSecret()) {
    const keys = deriveKeys(deviceSecret)

    return encodeMetaStealthAddress({
        spendingPublicKey: keys.spending.publicKey,
        viewingPublicKey: keys.viewing.publicKey
    })
}
