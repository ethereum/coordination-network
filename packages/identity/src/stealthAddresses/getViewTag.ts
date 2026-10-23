/**
 * First byte of the hashed shared secret, published in announcements so
 * scanners can skip 255/256 non-matching shared secrets.
 */
export function getViewTag(hashedSharedSecret: Uint8Array): number {
    return hashedSharedSecret[0]
}
