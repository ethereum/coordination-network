/** Shared stealth-address test helpers. */

import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"

import type { Address, Hex, Secp256k1Keypair } from "../../src/types"
import { bytesToHex, hexToBytes } from "../../src/bytes"
import { scalarToKeypair } from "../../src/keypair"
import { seededSecret } from "../helpers"

export function seededEphemeralKey(index: number): Secp256k1Keypair {
    return scalarToKeypair(keccak_256(hexToBytes(seededSecret(100 + index))))
}

/** Ethereum address of a private key: keccak256(X ‖ Y) of its pubkey, last 20 bytes. */
export function privateKeyToAddress(privateKey: Hex): Address {
    const publicKey = secp256k1.getPublicKey(hexToBytes(privateKey), false)
    return `0x${bytesToHex(keccak_256(publicKey.slice(1))).slice(-40)}`
}
