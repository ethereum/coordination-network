import { gcm } from "@noble/ciphers/aes"
import { managedNonce } from "@noble/ciphers/webcrypto"
import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, hexToBytes, type Hex } from "viem"

/**
 * Database values from `keys` and `accounts` tables reveal which stealth accounts belong to
 *  whom, so a leaked database dump would deanonymise every entity we scan for. Both keys
 * live in the environment, not the database they protect.
 */
export function createKeyCipher({
    encryptionKey,
    lookupHashKey
}: {
    encryptionKey: Uint8Array
    lookupHashKey: Uint8Array
}) {
    // managedNonce draws a fresh nonce per encryption and carries it in the ciphertext,
    // so the same value never gets encrypted to the same bytes twice
    const valueCipher = managedNonce(gcm)(encryptionKey)

    return {
        encrypt: (value: Hex): Hex => bytesToHex(valueCipher.encrypt(hexToBytes(value))),

        /** Throws when the stored value was tampered with or written under a different key. */
        decrypt: (encryptedValue: Hex): Hex => bytesToHex(valueCipher.decrypt(hexToBytes(encryptedValue))),

        lookupHash: (value: Hex): Hex => bytesToHex(hmac(sha256, lookupHashKey, hexToBytes(value)))
    }
}

export type KeyCipher = ReturnType<typeof createKeyCipher>
