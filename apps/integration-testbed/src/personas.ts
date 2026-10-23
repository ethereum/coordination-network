import { Hex32 } from "@coordination-network/credential"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import { hexToBytes } from "@noble/hashes/utils"

export type UserSecrets = {
    deviceSecret: Uint8Array
    devicePrivateKey: Uint8Array
    revocationSecret: Uint8Array
}

// X || Y of a secp256k1 point nobody holds the key to. x is the first value at or above
// keccak256("coordination-network/testbed/network-member") mod P with x^3 + 7 a square; y is the even root.
export const NETWORK_MEMBER_PUBLIC_KEY =
    "0xfcbf57658aeb3118dcd311239616b19419eb119e35f7e95910fc79174833c1873410fc07303ad68f306e62de3b8793b47783aff6c8276a2d4e8032ddbefb735e" as const

export const personas = {
    networkMember: {
        name: "Network Member",
        role: "Network Member",
        networkId: memberAccountKey(NETWORK_MEMBER_PUBLIC_KEY).memberNetworkId as Hex32,
        credentialSigningSeed: hexToBytes("01".repeat(32)),
        networkMemberIdentitySeed: hexToBytes("11".repeat(32))
    },
    alice: {
        name: "Alice",
        role: "Self-Sovereign User",
        deviceSecret: hexToBytes("07".repeat(32)),
        devicePrivateKey: hexToBytes("09".repeat(32)),
        revocationSecret: hexToBytes("0b".repeat(32))
    },
    bob: {
        name: "Bob",
        role: "Verifier",
        deviceSecret: hexToBytes("0d".repeat(32)),
        audience: `urn:cn:network:${"bb".repeat(32)}`
    },
    charlie: {
        name: "Charlie",
        role: "User",
        deviceSecret: hexToBytes("0f".repeat(32))
    },
    eve: {
        name: "Eve",
        role: "Unapproved Issuer",
        networkId: `0x${"cc".repeat(32)}` as Hex32,
        credentialSigningSeed: hexToBytes("03".repeat(32))
    }
}

// Guessable fixtures that pad the approved set; never promote them to real issuer keys.
export const peerIssuerSigningSeeds = [
    hexToBytes("02".repeat(32)),
    hexToBytes("04".repeat(32)),
    hexToBytes("05".repeat(32))
]
