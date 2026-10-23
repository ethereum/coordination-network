import { Address, Hex } from "../types"
import { computeSharedSecret } from "./computeSharedSecret"
import { getViewTag } from "./getViewTag"
import { getStealthPublicKey } from "./getStealthPublicKey"
import { publicKeyToAddress } from "./publicKeyToAddress"

/**
 * Checks whether an announcement is addressed to a recipient: filters by
 * view-tag first, then full address recompute.
 */
export function checkStealthAddress({
    stealthAddress,
    ephemeralPublicKey,
    spendingPublicKey,
    viewingPrivateKey,
    viewTag
}: {
    stealthAddress: Address
    ephemeralPublicKey: Hex
    spendingPublicKey: Hex
    viewingPrivateKey: Hex
    viewTag: number
}): boolean {
    const hashedSharedSecret = computeSharedSecret({
        privateKey: viewingPrivateKey,
        publicKey: ephemeralPublicKey
    })

    if (viewTag !== getViewTag(hashedSharedSecret)) {
        return false
    }

    const stealthPublicKey = getStealthPublicKey({ spendingPublicKey, hashedSharedSecret })
    const expectedStealthAddress = publicKeyToAddress(stealthPublicKey)

    return expectedStealthAddress.toLowerCase() === stealthAddress.toLowerCase()
}
