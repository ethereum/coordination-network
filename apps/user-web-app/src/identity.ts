import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils"
import {
    deriveEddsaKeypair,
    deriveKeys,
    eddsaPeerPointBytes,
    encodeMetaStealthAddress,
    type DerivedKeys
} from "@coordination-network/identity"
import { LocalP256Signer, type DeviceSigner } from "@coordination-network/credential"
import type { Store } from "@coordination-network/wallet"

const IDENTITY_KEY = "app:identity"

interface StoredIdentity {
    deviceSecret: string
    devicePrivateKey: string
}
export interface BrowserIdentity {
    keys: DerivedKeys
    metaStealthAddress: `0x${string}`
    deviceSigner: DeviceSigner
    identitySeed: Uint8Array
    identityPublicKey: [string, string]
    identityCommitment: bigint
    deviceSecret: Uint8Array
}

export async function loadOrCreateIdentity(store: Store): Promise<BrowserIdentity> {
    const existing = await store.get(IDENTITY_KEY)
    const record: StoredIdentity = existing
        ? JSON.parse(existing)
        : {
              deviceSecret: bytesToHex(randomBytes(32)),
              devicePrivateKey: bytesToHex(p256.utils.randomSecretKey())
          }
    if (!existing) await store.set(IDENTITY_KEY, JSON.stringify(record))
    const deviceSecret = hexToBytes(record.deviceSecret)
    const devicePrivateKey = hexToBytes(record.devicePrivateKey)
    const keys = deriveKeys(deviceSecret)
    const ecdhSecret = p256.getSharedSecret(devicePrivateKey, eddsaPeerPointBytes()).slice(1, 33)
    const identityKey = deriveEddsaKeypair(ecdhSecret)
    const identitySeed = hexToBytes(identityKey.seed.slice(2))
    return {
        keys,
        deviceSecret,
        identitySeed,
        identityPublicKey: identityKey.publicKey.map(String) as [string, string],
        identityCommitment: identityKey.commitment,
        deviceSigner: new LocalP256Signer(devicePrivateKey),
        metaStealthAddress: encodeMetaStealthAddress({
            spendingPublicKey: keys.spending.publicKey,
            viewingPublicKey: keys.viewing.publicKey
        })
    }
}
