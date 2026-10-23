import type { Group } from "./types"

/** Display metadata for a key-family group, mirroring the "three keys" design. */
export interface GroupMeta {
    key: Group
    /** Section title, e.g. "Account key A". */
    title: string
    /** The curve this key lives on, or "" for the issuer group. */
    curve: string
    /** One-line derivation path shown under the title. */
    role: string
    /** Accent colour — the section header and each row's left edge. */
    accent: string
}

/**
 * The four sections, in the order the design tells the story: account key →
 * device key → EdDSA key → issuer verification. Colours track the reference
 * diagram (secp256k1 red, P-256 blue, Baby Jubjub purple, verification green).
 */
export const GROUPS: readonly GroupMeta[] = [
    {
        key: "account",
        title: "Account key A",
        curve: "secp256k1",
        role: "Device Secret → privKey A → networkId",
        accent: "#ff6b6b"
    },
    {
        key: "device-key",
        title: "Device key B",
        curve: "P-256",
        role: "Secure Enclave → privKey B → confirmationKey → sig_B",
        accent: "#0a84ff"
    },
    {
        key: "eddsa",
        title: "Revocation id r",
        curve: "Baby Jubjub",
        role: "ECDH(device key B, Q) → Baby Jubjub keypair → commitment",
        accent: "#bf5af2"
    },
    {
        key: "issuer",
        title: "Issuer verification",
        curve: "",
        role: "replay committed vectors · verify all three (gates G1–G3)",
        accent: "#30d158"
    }
]
