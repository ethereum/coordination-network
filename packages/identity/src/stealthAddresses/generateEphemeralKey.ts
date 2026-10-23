import { scalarToKeypair } from "../keypair"
import { hexToBytes } from "../bytes"
import { Secp256k1Keypair } from "../types"
import { generateDeviceSecret } from "../device-secret"

/**
 * A fresh CSPRNG keypair for one load. MUST be single-use — reusing an
 * ephemeral key derives the same stealth address twice.
 */
export function generateEphemeralKey(): Secp256k1Keypair {
    return scalarToKeypair(hexToBytes(generateDeviceSecret()))
}
