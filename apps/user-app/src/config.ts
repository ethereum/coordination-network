import AsyncStorage from "@react-native-async-storage/async-storage"
import type { Brand } from "@coordination-network/app-ui"
import type { Hex } from "@coordination-network/identity"

const STACK_CONFIG_KEY = "user-app.stack-config"

export type MemberRole = "founder" | "candidate"

/** One network member the stack registered, as `yarn stack` prints it. Its `brand` is read verbatim off `stack.json`; see `apps/integration-testbed/src/serve.ts`. */
export interface StackMember {
    name: string
    networkId: Hex
    serverUrl: string
    authAddress: Hex
    governanceSigner: Hex
    role: MemberRole
    brand: Brand
    /** The org app's own deep-link scheme, when this member has one. */
    scheme?: string
}

/* A wallet calls only open routes, so the parse below copies just these fields and never stores an org token. */

/** The `stack.json` shape `apps/integration-testbed/src/serve.ts` prints (and QR-encodes). */
export interface StackDescriptor {
    rpcUrl: string
    chainId: number
    identityRegistry: Hex
    announcer: Hex
    /** `address` is the revocation service; `registry`/`registryId` name the one credential
     *  registry inside it that the whole network shares. */
    revocation: { address: Hex; registry: Hex; registryId: string }
    semaphore: Hex
    networkMemberRegistry: Hex
    networkMemberGroup: Hex
    networkMemberGovernance: Hex
    approvedIssuerSet: Hex
    governanceSafe: Hex
    entryPoint: Hex
    paymaster: Hex
    accountImplementation: Hex
    bundlerUrl: string
    dashboardUrl: string
    members: StackMember[]
}

const HEX_FIELDS = [
    "identityRegistry",
    "announcer",
    "semaphore",
    "networkMemberRegistry",
    "networkMemberGroup",
    "networkMemberGovernance",
    "approvedIssuerSet",
    "governanceSafe",
    "entryPoint",
    "paymaster",
    "accountImplementation"
] as const satisfies readonly (keyof StackDescriptor)[]

const URL_FIELDS = ["bundlerUrl", "dashboardUrl"] as const satisfies readonly (keyof StackDescriptor)[]

function isHex(value: unknown): value is Hex {
    return typeof value === "string" && value.startsWith("0x")
}

function isMemberRole(value: unknown): value is MemberRole {
    return value === "founder" || value === "candidate"
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

function isHexColor(value: unknown): value is string {
    return typeof value === "string" && HEX_COLOR.test(value)
}

const BRAND_HEX_FIELDS = ["accent", "onAccent", "accentSoft", "accentInk"] as const satisfies readonly (keyof Brand)[]

/** Throws naming the first invalid field, so a malformed brand reports exactly what's wrong. */
function assertBrand(value: unknown, index: number): void {
    if (typeof value !== "object" || value === null) throw new Error(`members[${index}].brand`)
    const brand = value as Record<string, unknown>
    for (const field of BRAND_HEX_FIELDS) {
        if (!isHexColor(brand[field])) throw new Error(`members[${index}].brand.${field}`)
    }
}

const MEMBER_STRING_FIELDS = ["name", "serverUrl"] as const satisfies readonly (keyof StackMember)[]

const MEMBER_HEX_FIELDS = [
    "networkId",
    "authAddress",
    "governanceSigner"
] as const satisfies readonly (keyof StackMember)[]

/** Throws naming the first invalid field, so a malformed member reports exactly what's wrong. */
function assertStackMember(value: unknown, index: number): void {
    if (typeof value !== "object" || value === null) throw new Error(`members[${index}] is not an object`)
    const member = value as Record<string, unknown>
    for (const field of MEMBER_STRING_FIELDS) {
        if (typeof member[field] !== "string") throw new Error(`members[${index}].${field}`)
    }
    for (const field of MEMBER_HEX_FIELDS) {
        if (!isHex(member[field])) throw new Error(`members[${index}].${field}`)
    }
    if (!isMemberRole(member.role)) throw new Error(`members[${index}].role`)
    assertBrand(member.brand, index)
    if (member.scheme !== undefined && typeof member.scheme !== "string") throw new Error(`members[${index}].scheme`)
}

/**
 * Parses a scanned or pasted `stack.json`. Thrown messages are shown directly on the Config
 * screen, so they name what's wrong rather than just "invalid JSON".
 */
export function parseStackDescriptor(raw: string): StackDescriptor {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error("that isn't valid JSON")
    }

    if (typeof parsed !== "object" || parsed === null) throw new Error("expected a JSON object")
    const descriptor = parsed as Record<string, unknown>

    if (typeof descriptor.rpcUrl !== "string") throw new Error("missing rpcUrl")
    if (typeof descriptor.chainId !== "number") throw new Error("missing chainId")
    for (const field of HEX_FIELDS) {
        if (!isHex(descriptor[field])) throw new Error(`missing ${field}`)
    }
    for (const field of URL_FIELDS) {
        if (typeof descriptor[field] !== "string") throw new Error(`missing ${field}`)
    }

    const revocation = descriptor.revocation as Record<string, unknown> | undefined
    if (!isHex(revocation?.address)) throw new Error("missing revocation.address")
    if (!isHex(revocation.registry)) throw new Error("missing revocation.registry")
    if (typeof revocation.registryId !== "string") throw new Error("missing revocation.registryId")

    if (!Array.isArray(descriptor.members)) throw new Error("missing members")
    for (const [index, member] of descriptor.members.entries()) {
        assertStackMember(member, index)
    }

    return {
        rpcUrl: descriptor.rpcUrl,
        chainId: descriptor.chainId,
        identityRegistry: descriptor.identityRegistry as Hex,
        announcer: descriptor.announcer as Hex,
        revocation: {
            address: revocation.address,
            registry: revocation.registry,
            registryId: revocation.registryId
        },
        semaphore: descriptor.semaphore as Hex,
        networkMemberRegistry: descriptor.networkMemberRegistry as Hex,
        networkMemberGroup: descriptor.networkMemberGroup as Hex,
        networkMemberGovernance: descriptor.networkMemberGovernance as Hex,
        approvedIssuerSet: descriptor.approvedIssuerSet as Hex,
        governanceSafe: descriptor.governanceSafe as Hex,
        entryPoint: descriptor.entryPoint as Hex,
        paymaster: descriptor.paymaster as Hex,
        accountImplementation: descriptor.accountImplementation as Hex,
        bundlerUrl: descriptor.bundlerUrl as string,
        dashboardUrl: descriptor.dashboardUrl as string,
        members: (descriptor.members as Record<string, unknown>[]).map((member): StackMember => ({
            name: member.name as string,
            networkId: member.networkId as Hex,
            serverUrl: member.serverUrl as string,
            authAddress: member.authAddress as Hex,
            governanceSigner: member.governanceSigner as Hex,
            role: member.role as MemberRole,
            brand: member.brand as Brand,
            ...(member.scheme === undefined ? {} : { scheme: member.scheme as string })
        }))
    }
}

function looksLikeUrl(raw: string): boolean {
    return /^https?:\/\//i.test(raw)
}

/**
 * The dashboard's QR (and the terminal's) now encodes `stack.json`'s URL rather than the JSON
 * itself — the widened descriptor no longer fits a scannable code. Scanned or pasted text is
 * either that URL, fetched and parsed, or the JSON itself, pasted directly.
 */
export async function resolveStackDescriptor(raw: string): Promise<StackDescriptor> {
    const trimmed = raw.trim()
    if (!looksLikeUrl(trimmed)) return parseStackDescriptor(trimmed)

    const response = await fetch(trimmed)
    if (!response.ok) throw new Error(`fetching ${trimmed} failed with status ${response.status}`)
    return parseStackDescriptor(await response.text())
}

/** A descriptor an older build persisted with fields the current shape needs is treated as unconfigured. */
export async function readStackConfig(): Promise<StackDescriptor | null> {
    const raw = await AsyncStorage.getItem(STACK_CONFIG_KEY)
    if (raw === null) return null
    try {
        return parseStackDescriptor(raw)
    } catch {
        return null
    }
}

export async function writeStackConfig(descriptor: StackDescriptor): Promise<void> {
    await AsyncStorage.setItem(STACK_CONFIG_KEY, JSON.stringify(descriptor))
}
