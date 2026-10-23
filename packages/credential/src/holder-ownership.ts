import { Identity } from "@semaphore-protocol/identity"
import { nonceToBigint } from "./revocation"
import type { EddsaPublicKey, EddsaSignature } from "./types"

/** Proves possession of the holder identity key bound into a credential request. */
export function signHolderKeyOwnership(
    identitySeed: Uint8Array,
    nonce: Uint8Array
): { publicKey: EddsaPublicKey; signature: EddsaSignature } {
    if (identitySeed.length !== 32) throw new Error("identity seed must be 32 bytes")
    const identity = new Identity(identitySeed)
    const signature = identity.signMessage(nonceToBigint(nonce))
    return {
        publicKey: [identity.publicKey[0], identity.publicKey[1]],
        signature: { R8: [signature.R8[0], signature.R8[1]], S: signature.S }
    }
}

/** Verifies that the requestor controls the supplied Baby Jubjub holder public key. */
export function verifyHolderKeyOwnership(params: {
    publicKey: EddsaPublicKey
    signature: EddsaSignature
    nonce: Uint8Array
}): boolean {
    try {
        return Identity.verifySignature(nonceToBigint(params.nonce), params.signature, params.publicKey)
    } catch {
        return false
    }
}
