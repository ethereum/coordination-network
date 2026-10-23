import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"

import { computeSharedSecret } from "../../src/stealthAddresses/computeSharedSecret"
import { bytesToHex, hexToBytes } from "../../src/bytes"
import { seededEphemeralKey } from "./helpers"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

describe("computeSharedSecret", () => {
    it("generates same shared secret from both parties inputs", () => {
        const { viewing } = deriveKeys(seededSecret(0))
        const ephemeral = seededEphemeralKey(0)

        // Sender knows its ephemeral private key + the recipient's viewing public key.
        const sender = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })
        // Recipient knows its viewing private key + the announced ephemeral public key.
        const receiver = computeSharedSecret({
            privateKey: viewing.privateKey,
            publicKey: ephemeral.publicKey
        })

        expect(bytesToHex(sender)).toBe(bytesToHex(receiver))
    })

    it("hashes the 33-byte compressed shared-secret point", () => {
        const { viewing } = deriveKeys(seededSecret(1))
        const ephemeral = seededEphemeralKey(1)

        const compressedPoint = secp256k1.getSharedSecret(
            hexToBytes(ephemeral.privateKey),
            hexToBytes(viewing.publicKey),
            true
        )
        const expected = keccak_256(compressedPoint)

        const hashedSharedSecret = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })

        expect(bytesToHex(hashedSharedSecret)).toBe(bytesToHex(expected))
    })
})
