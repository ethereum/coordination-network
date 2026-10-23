import { assertCompressedPublicKey } from "./assertCompressedPublicKey"

/** Validates 66-byte meta stealth address: shape and curve checks */
export function validateMetaStealthAddress(metaStealthAddress: string): boolean {
    if (!metaStealthAddress.startsWith("0x")) {
        return false
    }

    const cleanedMetaStealthAddress = metaStealthAddress.slice(2)

    try {
        assertCompressedPublicKey(`0x${cleanedMetaStealthAddress.slice(0, 66)}`, "spending")
        assertCompressedPublicKey(`0x${cleanedMetaStealthAddress.slice(66)}`, "viewing")
    } catch {
        return false
    }

    return true
}
