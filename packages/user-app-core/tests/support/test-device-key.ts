import { p256 } from "@noble/curves/nist.js"
import { LocalP256Signer } from "@coordination-network/credential"
import { DeviceKeyError } from "../../src/errors"
import type { DeviceKey, KeyPrompt } from "../../src/types"

type KeyOp = "sign" | "signDigest" | "ecdh"

/** A `DeviceKey` that also records what was asked of it and can be made to fail. */
export interface TestDeviceKey extends DeviceKey {
    /** Every prompt a sign, signDigest or ecdh raised, in order. */
    readonly prompts: KeyPrompt[]
    /** Every use of the keys, in order, including `getPublicKeyJwk`. */
    readonly calls: string[]
    /** What `getAttestationChain` returns; empty, like a software key's, until a test sets it. */
    attestationChain: string[]
    /** Makes the next `op` throw `DeviceKeyError(code)` after raising its prompt. */
    failWith(op: KeyOp, code: DeviceKeyError["code"]): void
}

/**
 * A `DeviceKey` over a software P-256 key, for tests. Reuses `LocalP256Signer` for signing and
 * adds plain P-256 ECDH, matching what a real Keystore's raw shared-secret output looks like.
 * Software keys never prompt, so `prompts` records what a device would have shown.
 */
export function createTestDeviceKey(privateKey: Uint8Array = p256.utils.randomSecretKey()): TestDeviceKey {
    const signer = new LocalP256Signer(privateKey)
    const prompts: KeyPrompt[] = []
    const calls: string[] = []
    const failures = new Map<KeyOp, DeviceKeyError["code"]>()

    function use(op: KeyOp, prompt: KeyPrompt): void {
        calls.push(op)
        prompts.push(prompt)
        const code = failures.get(op)
        if (code !== undefined) {
            failures.delete(op)
            throw new DeviceKeyError(code)
        }
    }

    return {
        prompts,
        calls,
        attestationChain: [],
        failWith: (op, code) => failures.set(op, code),
        async getPublicKeyJwk() {
            calls.push("getPublicKeyJwk")
            return signer.getPublicKeyJwk()
        },
        signerFor: (prompt) => ({
            getPublicKeyJwk: () => signer.getPublicKeyJwk(),
            async sign(message) {
                use("sign", prompt)
                return signer.sign(message)
            },
            async signDigest(digest) {
                use("signDigest", prompt)
                return signer.signDigest(digest)
            }
        }),
        async ecdh(peerPublicKey, prompt) {
            use("ecdh", prompt)
            return p256.getSharedSecret(privateKey, peerPublicKey, true).slice(1)
        },
        async getSecurityLevel() {
            return "SOFTWARE"
        },
        async getAttestationChain() {
            return this.attestationChain
        }
    }
}

/** For tests that need the same shared secret independently, without going through a `DeviceKey`. */
export function sharedSecretFor(privateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
    return p256.getSharedSecret(privateKey, peerPublicKey, true).slice(1)
}
