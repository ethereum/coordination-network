import { Jwk } from "./types"

/** Holder P-256 device key backed by a secure element in production. */
export interface DeviceSigner {
    getPublicKeyJwk(): Promise<Jwk>
    sign(message: Uint8Array): Promise<Uint8Array>
    /** Signs an already-computed 32-byte digest, without hashing it again. */
    signDigest(digest: Uint8Array): Promise<Uint8Array>
}
