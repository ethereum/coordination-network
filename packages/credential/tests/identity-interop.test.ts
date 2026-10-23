import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"
import { hexToBytes, randomBytes } from "@noble/hashes/utils"
import {
    buildDeviceBindingMessage,
    computeNetworkId,
    signAccountBinding,
    verifyCredentialBinding
} from "@coordination-network/identity"
import { issuanceRequestCommitment, jwkToPublicKeyBytes, LocalP256Signer } from "@coordination-network/credential"

/** Proves the credential layer and the identity layer agree on the binding scheme. */
describe("identity package interop", () => {
    it("verifies a binding built entirely from identity primitives", async () => {
        const accountPrivateKey = hexToBytes("07".repeat(32))
        const accountPublicKey = secp256k1.getPublicKey(accountPrivateKey, true)
        const deviceSigner = LocalP256Signer.generate()
        const confirmationKey = jwkToPublicKeyBytes(await deviceSigner.getPublicKeyJwk())
        const nonce = randomBytes(32)
        const holderKeyCommitment = randomBytes(32)
        const requestCommitment = issuanceRequestCommitment(`0x${"aa".repeat(32)}`, {
            programme: "test-programme",
            country: "ZZZ"
        })

        const networkId = computeNetworkId(secp256k1.getPublicKey(accountPrivateKey, false))
        const deviceSignature = await deviceSigner.sign(
            buildDeviceBindingMessage(nonce, networkId, holderKeyCommitment, requestCommitment)
        )
        const accountSignature = hexToBytes(
            signAccountBinding(accountPrivateKey, nonce, confirmationKey).signature.slice(2)
        )

        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey,
            confirmationKey,
            holderKeyCommitment,
            requestCommitment,
            accountSignature,
            deviceSignature
        })

        expect(result.valid).toBe(true)
        expect(result.networkId).toBe(networkId)
    })
})
