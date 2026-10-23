import type { DerivedKeys, Hex } from "./types"
import { KEY_DERIVATION_VERSION } from "./constants"
import { deriveAccountKeypair, signDerivationMessage } from "./account"
import { deriveStealthKeys } from "./stealthAddresses/deriveStealthKeys"
import { deriveAuthKeypair } from "./auth"
import { computeMemberNetworkId, computeNetworkId } from "./network-id"

/**
 * Derives the full `v2` device identity — `networkId`, `memberNetworkId` and the account,
 * spending, viewing and auth secp256k1 keypairs — from a single device secret.
 *
 * Pipeline (NORMATIVE):
 * 1. `account = deriveAccountKeypair(deviceSecret)`
 * 2. `networkId = computeNetworkId(account.uncompressedPublicKey)` and
 *    `memberNetworkId = computeMemberNetworkId(account.uncompressedPublicKey)`
 * 3. `sig = signDerivationMessage(account.privateKey)` (EIP-191, deterministic)
 * 4. `{ spending, viewing } = deriveStealthKeys(sig)` (FluidKey semantics)
 * 5. `auth = deriveAuthKeypair(sig)`
 */
export function deriveKeys(deviceSecret: Uint8Array | Hex): DerivedKeys {
    const account = deriveAccountKeypair(deviceSecret)
    const networkId = computeNetworkId(account.uncompressedPublicKey)
    const memberNetworkId = computeMemberNetworkId(account.uncompressedPublicKey)
    const signature = signDerivationMessage(account.privateKey)
    const { spending, viewing } = deriveStealthKeys(signature)
    const auth = deriveAuthKeypair(signature)

    return {
        version: KEY_DERIVATION_VERSION,
        networkId,
        memberNetworkId,
        account,
        spending,
        viewing,
        auth
    }
}

/** Derives only the `networkId` — equal to `deriveKeys(deviceSecret).networkId`, minus the signature work. */
export function deriveNetworkId(deviceSecret: Uint8Array | Hex): Hex {
    const account = deriveAccountKeypair(deviceSecret)

    return computeNetworkId(account.uncompressedPublicKey)
}
