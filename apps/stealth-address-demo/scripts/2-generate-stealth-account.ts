import { decodeMetaStealthAddress, generateStealthAddress, Hex } from "@coordination-network/identity"

/** Step 2, sender. Derives the account to pay. */
export function generateStealthAccount(metaStealthAddress: string, ephemeralPrivateKey: Hex) {
    const { spendingPublicKey, viewingPublicKey } = decodeMetaStealthAddress(metaStealthAddress)

    return generateStealthAddress({
        viewingPublicKey,
        spendingPublicKey,
        ephemeralPrivateKey
    })
}
