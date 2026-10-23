import { isIPv4 } from "node:net"
import { networkInterfaces } from "node:os"
import { Address, concat, keccak256, numberToBytes, stringToBytes } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { Identity } from "@semaphore-protocol/identity"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils"
import { CredentialSigner, Hex32, LocalCredentialSigner } from "@coordination-network/credential"
import { deriveKeys, encodeMetaStealthAddress } from "@coordination-network/identity"
import { optionalEnvironmentVariable } from "./anvil"
import { OperatorError } from "./operator-error"

/** A port setting, where a blank value is the default rather than port 0 or NaN. Not validated here:
 *  this runs when the module loads, before the top level can report an operator error. */
export function portFromEnvironment(name: string, fallback: number): number {
    return Number(optionalEnvironmentVariable(name) ?? fallback)
}

export const STACK_PORT = portFromEnvironment("STACK_PORT", 8545)
export const MEMBER_PORTS = (optionalEnvironmentVariable("STACK_MEMBER_PORTS") ?? "3001,3002,3003")
    .split(",")
    .map(Number)

function validatePort(name: string, text: string): void {
    const port = /^\d+$/.test(text.trim()) ? Number(text) : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new OperatorError(`${name} must be a port from 1 to 65535, got "${text}"`)
    }
}

/** Refuses a bad port or host setting by name, before the stack binds or publishes anything. */
export function validateStackSettings(): void {
    for (const name of ["STACK_PORT", "STACK_BUNDLER_PORT", "STACK_DASHBOARD_PORT"]) {
        const text = optionalEnvironmentVariable(name)
        if (text !== undefined) validatePort(name, text)
    }
    const memberPorts = optionalEnvironmentVariable("STACK_MEMBER_PORTS")
    if (memberPorts !== undefined) {
        const fields = memberPorts.split(",")
        if (fields.length !== 3) {
            throw new OperatorError("STACK_MEMBER_PORTS must be exactly three comma-separated ports")
        }
        for (const field of fields) validatePort("STACK_MEMBER_PORTS", field)
    }
    lanAddress()
}

/** VPN and virtual interfaces carry addresses a phone on the same Wi-Fi cannot route to. */
const TUNNEL_INTERFACE = /^(utun|tun|tap|ppp|awdl|llw|bridge|vmnet|vboxnet|docker|veth)/

/** A point-to-point tunnel address is a /30 or narrower; a real LAN is far wider. */
function isPointToPoint(netmask: string): boolean {
    const maskBits = netmask
        .split(".")
        .reduce((bits, octet) => bits + Number(octet).toString(2).split("1").length - 1, 0)
    return maskBits >= 30
}

/**
 * The address a phone scanning the QR has to reach. Picking the first non-internal IPv4 hands out
 * the VPN tunnel's address whenever one is up, which times out rather than failing loudly.
 */
export function lanAddress(): string {
    const candidates: string[] = []

    for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family !== "IPv4" || address.internal) continue
            if (TUNNEL_INTERFACE.test(name) || isPointToPoint(address.netmask)) continue
            candidates.push(address.address)
        }
    }

    // A deployed network's dashboard holds every org's member server token and sends permanent
    // transactions, so it stays on loopback unless the operator names a host.
    const fallback = process.env.TESTBED_MODE === "testnet" ? undefined : candidates[0]
    const configured = optionalEnvironmentVariable("STACK_HOST")
    // The host guard answers 421 to a DNS name, and 0.0.0.0 is not an address a phone can reach.
    if (configured !== undefined && (!isIPv4(configured) || configured === "0.0.0.0")) {
        throw new OperatorError(`STACK_HOST must be an IPv4 address a phone can reach, not "${configured}"`)
    }
    return configured ?? fallback ?? "127.0.0.1"
}

/** Three 32-byte secrets, one per member, each seeding both its Semaphore identity and `deriveKeys`.
 *  Random per run unless `STACK_MEMBER_SEEDS` names them, which a deployed network has to. */
export function memberSecrets(): [Uint8Array, Uint8Array, Uint8Array] {
    const raw = optionalEnvironmentVariable("STACK_MEMBER_SEEDS")
    if (raw === undefined) return [randomBytes(32), randomBytes(32), randomBytes(32)]
    const fields = raw.split(",").map((seed) => seed.trim().replace(/^0x/, ""))
    if (fields.length !== 3 || !fields.every((field) => /^[0-9a-fA-F]{64}$/.test(field))) {
        throw new OperatorError("STACK_MEMBER_SEEDS must be exactly three comma-separated 32-byte hex seeds")
    }
    // One seed three times would make the three orgs a single identity: genesis would admit it once
    // and leave the Safe with one real org.
    if (new Set(fields.map((field) => field.toLowerCase())).size !== 3) {
        throw new OperatorError("STACK_MEMBER_SEEDS must be three distinct seeds")
    }
    const seeds = fields.map((field) => hexToBytes(field))
    return [seeds[0], seeds[1], seeds[2]]
}

export type MemberRole = "founder" | "candidate"

/** An org's colours: `stack.json` carries them verbatim for the wallet and the web pages to read. */
export interface Brand {
    accent: string
    onAccent: string
    accentSoft: string
    accentInk: string
}

const BLUE_BRAND: Brand = { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" }
const YELLOW_BRAND: Brand = { accent: "#f5b400", onAccent: "#17201c", accentSoft: "#fdf1cc", accentInk: "#8a5a00" }
const RED_BRAND: Brand = { accent: "#c8102e", onAccent: "#ffffff", accentSoft: "#fbe3e6", accentInk: "#c8102e" }

/**
 * The three orgs the demo network opens with. Member A and Member B are founders, admitted at
 * genesis, so the five flows run between them from the first minute; Member C is the candidate the
 * admission story is about. `scheme` is the org app's own deep-link scheme (that app derives it
 * from `EXPO_PUBLIC_MEMBER_ID`), so only the two with a phone app carry one.
 */
export const MEMBER_PROFILES: readonly {
    name: string
    role: MemberRole
    brand: Brand
    scheme?: string
}[] = [
    {
        name: "Member A",
        role: "founder",
        brand: BLUE_BRAND,
        scheme: "member-a"
    },
    {
        name: "Member B",
        role: "founder",
        brand: YELLOW_BRAND,
        scheme: "member-b"
    },
    {
        name: "Member C",
        role: "candidate",
        brand: RED_BRAND
    }
]

export interface Member {
    name: string
    networkId: Hex32
    /** The key `networkId`'s low 20 bytes encode: authenticates to `NetworkMemberRegistry` and
     * `ApprovedIssuerSet`. */
    authAddress: Address
    authPrivateKey: `0x${string}`
    /** This member's seat at the governance Safe, once admitted. Must differ from the auth key. */
    governanceSignerAddress: Address
    governanceSignerPrivateKey: `0x${string}`
    /** The member's leaf in the approved-member group, once admitted. */
    semaphoreCommitment: bigint
    /** The ERC-6538 meta-stealth address `registerNetworkMemberIdentity` will publish. */
    metaStealthAddress: `0x${string}`
    role: MemberRole
    signer: CredentialSigner
    /** The seed admitted to the approved-member group, so this server can reprove membership. */
    semaphoreSecret: Uint8Array
    walletPrivateKey: `0x${string}`
    port: number
    brand: Brand
    /** What this member's own governance, credential-listing and revoke routes ask for. */
    memberServerToken: string
    /** The org app's own deep-link scheme; absent for the server-only candidate. */
    scheme?: string
}

/**
 * The wallet and governance-signer keys an org's server runs with, derived from its seed so a
 * restart against a deployed network finds the same Safe owner. The label keeps each apart from
 * the other and from the auth key `deriveKeys` roots in the same seed.
 */
export function deriveMemberSigningKeys(seed: Uint8Array): {
    walletPrivateKey: `0x${string}`
    governanceSignerPrivateKey: `0x${string}`
} {
    return {
        walletPrivateKey: keccak256(concat([seed, stringToBytes("wallet")])),
        governanceSignerPrivateKey: keccak256(concat([seed, stringToBytes("governance")]))
    }
}

/** The key the org signs credentials with, from its seed: a public label would let anyone on a
 *  public chain reproduce it. Credential signatures carry no chain id, so the key does: a stack
 *  started on another chain with the same seeds never runs this chain's issuer keys. */
export function deriveCredentialSigner(seed: Uint8Array, chainId: number): LocalCredentialSigner {
    const label = concat([seed, stringToBytes("issuer"), numberToBytes(chainId, { size: 32 })])
    return new LocalCredentialSigner(hexToBytes(keccak256(label).slice(2)))
}

/**
 * Builds a member's full key set from one secret: the identity Semaphore commitment, the auth key
 * `deriveKeys` roots `memberNetworkId` in, and the meta-stealth address it will publish once admitted.
 * The governance signer and the wallet key come from {@link deriveMemberSigningKeys}, so they never
 * coincide with the auth key.
 */
export function buildMember(
    name: string,
    secret: Uint8Array,
    role: MemberRole,
    signer: CredentialSigner,
    walletPrivateKey: `0x${string}`,
    governanceSignerPrivateKey: `0x${string}`,
    port: number,
    brand: Brand,
    scheme?: string
): Member {
    const keys = deriveKeys(secret)

    return {
        name,
        networkId: keys.memberNetworkId,
        authAddress: privateKeyToAccount(keys.account.privateKey).address,
        authPrivateKey: keys.account.privateKey,
        governanceSignerAddress: privateKeyToAccount(governanceSignerPrivateKey).address,
        governanceSignerPrivateKey,
        semaphoreCommitment: new Identity(secret).commitment,
        metaStealthAddress: encodeMetaStealthAddress({
            spendingPublicKey: keys.spending.publicKey,
            viewingPublicKey: keys.viewing.publicKey
        }),
        role,
        signer,
        semaphoreSecret: secret,
        walletPrivateKey,
        port,
        brand,
        // Fresh per run rather than derived from `secret`: the demo secrets are checked in, and a
        // token anyone can read out of the source tree is not a token.
        memberServerToken: bytesToHex(randomBytes(32)),
        scheme
    }
}

/** The three demo orgs, each keyed from its seed so a restart finds the same network members. */
export function buildMembers(seeds: readonly Uint8Array[], chainId: number): Member[] {
    return MEMBER_PROFILES.map((profile, index) => {
        const { walletPrivateKey, governanceSignerPrivateKey } = deriveMemberSigningKeys(seeds[index])
        return buildMember(
            profile.name,
            seeds[index],
            profile.role,
            deriveCredentialSigner(seeds[index], chainId),
            walletPrivateKey,
            governanceSignerPrivateKey,
            MEMBER_PORTS[index],
            profile.brand,
            profile.scheme
        )
    })
}
