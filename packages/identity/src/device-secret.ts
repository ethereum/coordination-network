import type { Hex } from "./types"
import { bytesToHex } from "./bytes"
import { KeygenError } from "./errors"

/**
 * Generates a fresh 32-byte device secret from the platform CSPRNG
 * (`globalThis.crypto.getRandomValues`). Throws if no secure RNG is available
 * (e.g. React Native without the `react-native-get-random-values` polyfill).
 */
export function generateDeviceSecret(): Hex {
    const cryptoObj = globalThis.crypto

    if (typeof cryptoObj?.getRandomValues !== "function") {
        throw new KeygenError(
            "DERIVATION_FAILURE",
            "generateDeviceSecret: no secure random source (globalThis.crypto.getRandomValues) available"
        )
    }

    const bytes = new Uint8Array(32)
    cryptoObj.getRandomValues(bytes)

    return bytesToHex(bytes)
}
