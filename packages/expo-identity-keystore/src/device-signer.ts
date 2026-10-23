import { base64ToBytes, bytesToBase64, derToCompact, Jwk, sec1ToJwk } from "./encoding"
import type { AuthPrompt, Keystore } from "./native"

/**
 * Holder P-256 device key, same shape as `@coordination-network/credential`'s
 * `DeviceSigner` (declared locally to avoid pulling in credential's heavier
 * deps). `sign` hashes internally; `signDigest` takes a precomputed digest.
 */
export interface DeviceSigner {
    getPublicKeyJwk(): Promise<Jwk>
    sign(message: Uint8Array): Promise<Uint8Array>
    signDigest(digest: Uint8Array): Promise<Uint8Array>
}

/**
 * Wraps a `Keystore` alias as a `DeviceSigner` (compact 64-byte low-S
 * signatures). Never provisions the alias — `generateKey` would rotate an
 * existing key and invalidate signatures already bound to it — so this only
 * reads via `getPublicKey`, caching it after the first successful read.
 * `prompt` is shown for every `sign`/`signDigest`, so bind one signer per operation.
 */
export function createDeviceSigner(keystore: Keystore, alias: string, prompt: AuthPrompt): DeviceSigner {
    let publicKeyJwk: Promise<Jwk> | undefined

    function ensurePublicKey(): Promise<Jwk> {
        if (!publicKeyJwk) {
            publicKeyJwk = keystore.getPublicKey(alias).then((sec1Base64) => sec1ToJwk(base64ToBytes(sec1Base64)))
            // Cache only on success — a rejection (e.g. a temporarily locked keystore)
            // must not stick around and fail every later call; let the next one retry.
            publicKeyJwk.catch(() => {
                publicKeyJwk = undefined
            })
        }
        return publicKeyJwk
    }

    return {
        getPublicKeyJwk: ensurePublicKey,

        async sign(message: Uint8Array): Promise<Uint8Array> {
            await ensurePublicKey()
            const signatureDer = base64ToBytes(await keystore.sign(alias, bytesToBase64(message), prompt))
            return derToCompact(signatureDer)
        },

        async signDigest(digest: Uint8Array): Promise<Uint8Array> {
            await ensurePublicKey()
            const signatureDer = base64ToBytes(await keystore.signDigest(alias, bytesToBase64(digest), prompt))
            return derToCompact(signatureDer)
        }
    }
}
