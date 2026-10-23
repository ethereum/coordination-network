import { Address, Hex } from "../types"
import { ERC_5564_SCHEME_ID } from "../constants"
import { bytesToHex } from "../bytes"
import { decodeMetaStealthAddress } from "./decodeMetaStealthAddress"
import { generateEphemeralKey } from "./generateEphemeralKey"
import { computeSharedSecret } from "./computeSharedSecret"
import { getStealthPublicKey } from "./getStealthPublicKey"
import { publicKeyToAddress } from "./publicKeyToAddress"
import { getViewTag } from "./getViewTag"

/**
 * Builds an ERC-5564 announcement payload for a fresh stealth address,
 * generates ephemeral key internally. The view tag is the
 * first and only metadata byte.
 */
export function buildAnnouncement({ metaStealthAddress }: { metaStealthAddress: Hex }): {
    schemeId: typeof ERC_5564_SCHEME_ID
    stealthAddress: Address
    ephemeralPublicKey: Hex
    metadata: Hex
} {
    const { spendingPublicKey, viewingPublicKey } = decodeMetaStealthAddress(metaStealthAddress)
    const ephemeralKey = generateEphemeralKey()

    const hashedSharedSecret = computeSharedSecret({
        privateKey: ephemeralKey.privateKey,
        publicKey: viewingPublicKey
    })
    const stealthPublicKey = getStealthPublicKey({ spendingPublicKey, hashedSharedSecret })

    return {
        schemeId: ERC_5564_SCHEME_ID,
        stealthAddress: publicKeyToAddress(stealthPublicKey),
        ephemeralPublicKey: ephemeralKey.publicKey,
        metadata: bytesToHex(Uint8Array.of(getViewTag(hashedSharedSecret)))
    }
}
