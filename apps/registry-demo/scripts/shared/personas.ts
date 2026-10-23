import { deriveKeys, deriveNetworkId, encodeMetaStealthAddress } from "@coordination-network/identity"
import { Identity } from "@semaphore-protocol/identity"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import type { Hex } from "viem"
import type { HDAccount } from "viem/accounts"
import { roles } from "./config.ts"

/** A prospective or approved network member, and the four things it holds. */
export interface Member {
    /** A label, for the demo's own output. The chain knows nothing about it. */
    name: string
    /** The networkId, `keccak256(X || Y)` of the auth key's public key. */
    networkId: Hex
    /** The coordinates of the auth key's public key, which the registry takes in place of the id. */
    accountKeyX: bigint
    accountKeyY: bigint
    /** The auth key, the member's account key: announces the join request, and writes this member's own record. */
    auth: HDAccount
    /** The governance signer: this member's seat at the Safe. Must differ from the auth key. */
    governanceSigner: HDAccount
    /** The Semaphore identity whose commitment becomes this member's leaf in the approved-member group. */
    identity: Identity
    /** Where approvers fetch this member's vetting material. The contract neither reads nor stores it. */
    metadataURI: string
}

function member(name: string, keys: { auth: HDAccount; governanceSigner: HDAccount }, seed: string): Member {
    const { memberNetworkId, accountKeyX, accountKeyY } = memberAccountKey(keys.auth.publicKey)

    return {
        name,
        networkId: memberNetworkId,
        accountKeyX,
        accountKeyY,
        auth: keys.auth,
        governanceSigner: keys.governanceSigner,
        // A fixed seed keeps the demo's commitments reproducible across runs. A real member generates
        // this once and keeps it: the commitment is its identity in the group.
        identity: new Identity(seed),
        metadataURI: `https://example.invalid/${name.toLowerCase().replace(/\s+/g, "-")}/vetting.json`
    }
}

/**
 * The members the network is founded with. Their governance signers are the Safe's owners from
 * deployment, and their records and group leaves are written by the genesis transaction.
 */
export const founders = roles.founders.map((keys, index) =>
    member(`Founder ${index + 1}`, keys, `registry-demo:founder-${index + 1}`)
)

/** The two members the walkthrough admits, removes and retires. */
export const alice = member("Alice", roles.alice, "registry-demo:alice")
export const bob = member("Bob", roles.bob, "registry-demo:bob")

/**
 * The ERC-6538 meta-stealth address for a device secret: the spending and viewing public keys
 * concatenated, 66 bytes, which is the length both registries require.
 */
export function metaStealthAddressFor(deviceSecret: Hex): Hex {
    const keys = deriveKeys(deviceSecret)

    return encodeMetaStealthAddress({
        spendingPublicKey: keys.spending.publicKey,
        viewingPublicKey: keys.viewing.publicKey
    })
}

/**
 * Someone a network member registers in the identity registry, so value can be routed to them.
 *
 * A user is not a member and holds no governance keys: everything here comes from one device secret,
 * which is all a recipient's wallet has.
 */
interface User {
    name: string
    /** Derived from the device secret, as the wallet derives it. Not an address like a member's. */
    networkId: Hex
    /** The meta-stealth address the registry resolves that networkId to. */
    metaStealthAddress: Hex
    /** The address after replacing the device, for the update the walkthrough performs. */
    rotatedMetaStealthAddress: Hex
}

function user(name: string, deviceSecret: Hex, replacementSecret: Hex): User {
    return {
        name,
        networkId: deriveNetworkId(deviceSecret),
        metaStealthAddress: metaStealthAddressFor(deviceSecret),
        rotatedMetaStealthAddress: metaStealthAddressFor(replacementSecret)
    }
}

/** The user a member registers, and one who is never registered, for the unresolved case. */
export const dana = user("Dana", `0x${"a1".repeat(32)}`, `0x${"a2".repeat(32)}`)
export const erin = user("Erin", `0x${"b1".repeat(32)}`, `0x${"b2".repeat(32)}`)
