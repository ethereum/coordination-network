import { p256 } from "@noble/curves/p256"
import { base64ToBytes, bytesToBase64 } from "./encoding"
import type {
    AuthPrompt,
    GenerateKeyOptions,
    GeneratedKey,
    Keystore,
    KeyPurpose,
    KeystoreSecurityLevel
} from "./native"

interface SoftwareKey {
    privateKey: Uint8Array
    purpose: KeyPurpose
}

/**
 * In-memory `Keystore` for platforms without the native module (iOS, Expo Go,
 * jest); not hardware-backed, but exercises the same code paths as the real one,
 * including each key's single purpose. It shows no prompts: it records them in
 * `prompts`, in call order, for each operation the native module would prompt for.
 */
export class SoftwareKeystore implements Keystore {
    readonly prompts: AuthPrompt[] = []

    private readonly keys = new Map<string, SoftwareKey>()

    private loadKey(alias: string): SoftwareKey {
        const key = this.keys.get(alias)
        if (!key) {
            throw new Error(`SoftwareKeystore: no key found for alias '${alias}'`)
        }
        return key
    }

    private loadPrivateKey(alias: string, purpose: KeyPurpose): Uint8Array {
        const key = this.loadKey(alias)
        if (key.purpose !== purpose) {
            throw new Error(`SoftwareKeystore: alias '${alias}' has purpose '${key.purpose}', not '${purpose}'`)
        }
        return key.privateKey
    }

    async generateKey(alias: string, { purpose }: GenerateKeyOptions): Promise<GeneratedKey> {
        const privateKey = p256.utils.randomSecretKey()
        this.keys.set(alias, { privateKey, purpose })
        return { publicKey: bytesToBase64(p256.getPublicKey(privateKey, false)), securityLevel: "SOFTWARE" }
    }

    async hasKey(alias: string): Promise<boolean> {
        return this.keys.has(alias)
    }

    async getPublicKey(alias: string): Promise<string> {
        return bytesToBase64(p256.getPublicKey(this.loadKey(alias).privateKey, false))
    }

    async sign(alias: string, messageBase64: string, prompt: AuthPrompt): Promise<string> {
        const privateKey = this.loadPrivateKey(alias, "sign")
        const message = base64ToBytes(messageBase64)
        this.prompts.push(prompt)
        return bytesToBase64(p256.sign(message, privateKey, { prehash: true, lowS: false }).toDERRawBytes())
    }

    async signDigest(alias: string, digestBase64: string, prompt: AuthPrompt): Promise<string> {
        const privateKey = this.loadPrivateKey(alias, "sign")
        const digest = base64ToBytes(digestBase64)
        if (digest.length !== 32) {
            throw new Error(`SoftwareKeystore.signDigest: expected a 32-byte digest, got ${digest.length} bytes`)
        }
        this.prompts.push(prompt)
        return bytesToBase64(p256.sign(digest, privateKey, { prehash: false, lowS: false }).toDERRawBytes())
    }

    async ecdh(alias: string, peerPublicKeyBase64: string, prompt: AuthPrompt): Promise<string> {
        const privateKey = this.loadPrivateKey(alias, "agree")
        const peerPublicKey = base64ToBytes(peerPublicKeyBase64)
        this.prompts.push(prompt)
        return bytesToBase64(p256.getSharedSecret(privateKey, peerPublicKey, true).slice(1))
    }

    async getSecurityLevel(alias: string): Promise<KeystoreSecurityLevel> {
        this.loadKey(alias)
        return "SOFTWARE"
    }

    async getAttestationChain(alias: string): Promise<string[]> {
        this.loadKey(alias)
        return []
    }

    async deleteKey(alias: string): Promise<void> {
        this.keys.delete(alias)
    }

    async eraseAll(): Promise<number> {
        const count = this.keys.size
        this.keys.clear()
        return count
    }
}
