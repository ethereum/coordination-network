import { bytesToHex, hexToBytes } from "@coordination-network/identity"

export { bytesToHex, hexToBytes }

/** Encodes a field element as the 32-byte big-endian value the binding and commitment builders expect. */
export function bigintToBytes32(value: bigint): Uint8Array {
    return hexToBytes(`0x${value.toString(16).padStart(64, "0")}`)
}
