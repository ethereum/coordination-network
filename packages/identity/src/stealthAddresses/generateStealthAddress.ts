import { Address, Hex } from "../types"
import { computeSharedSecret } from "./computeSharedSecret"
import { getStealthPublicKey } from "./getStealthPublicKey"
import { publicKeyToAddress } from "./publicKeyToAddress"

/**
 * Derives a fresh stealth address from the
 * recipient's spending and viewing public keys.
 */
export function generateStealthAddress({
    viewingPublicKey,
    spendingPublicKey,
    ephemeralPrivateKey
}: {
    viewingPublicKey: Hex
    spendingPublicKey: Hex
    ephemeralPrivateKey: Hex
}): Address {
    const hashedSharedSecret = computeSharedSecret({
        privateKey: ephemeralPrivateKey,
        publicKey: viewingPublicKey
    })

    const stealthPublicKey = getStealthPublicKey({ spendingPublicKey, hashedSharedSecret })

    return publicKeyToAddress(stealthPublicKey)
}
