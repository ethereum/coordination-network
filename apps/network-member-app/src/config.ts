import { z } from "zod"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { hex20Schema, hex32Schema } from "@coordination-network/user-app-link"
import type { MemberConfig } from "@coordination-network/network-member-app-core"

/** Mirrors the testbed's `StackDescriptor`, redeclared with zod because it is untrusted input and the testbed is no dependency. */
const memberRoleSchema = z.enum(["founder", "candidate"])

/** No `z.string().url()`/`z.url()`: both rely on the global `URL` class, which Hermes lacks without a polyfill. */
const httpUrlSchema = z.string().regex(/^https?:\/\/\S+$/i, "must be an http(s) URL")

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb colour")

/** The four colours a member is drawn in across the network's surfaces. This app keeps its own
 *  copy in `branding.ts` for the screens that render before a stack is loaded. */
const brandSchema = z
    .object({
        accent: hexColorSchema,
        onAccent: hexColorSchema,
        accentSoft: hexColorSchema,
        accentInk: hexColorSchema
    })
    .strict()

const stackMemberSchema = z
    .object({
        name: z.string().min(1),
        networkId: hex32Schema,
        serverUrl: httpUrlSchema,
        authAddress: hex20Schema,
        governanceSigner: hex20Schema,
        role: memberRoleSchema,
        brand: brandSchema,
        /** Only the members that ship a phone app have one, so a wallet can tell a caller claiming
         *  this member's name from the real thing. */
        scheme: z.string().min(1).optional()
    })
    .strict()

const stackDescriptorSchema = z
    .object({
        rpcUrl: httpUrlSchema,
        chainId: z.number(),
        identityRegistry: hex20Schema,
        announcer: hex20Schema,
        /** `address` is the network's revocation service; `registry`/`registryId` name the one
         *  credential registry inside it that every member writes to and every verifier reads. */
        revocation: z.object({ address: hex20Schema, registry: hex20Schema, registryId: z.string().min(1) }).strict(),
        semaphore: hex20Schema,
        networkMemberRegistry: hex20Schema,
        networkMemberGroup: hex20Schema,
        networkMemberGovernance: hex20Schema,
        approvedIssuerSet: hex20Schema,
        governanceSafe: hex20Schema,
        entryPoint: hex20Schema,
        paymaster: hex20Schema,
        accountImplementation: hex20Schema,
        bundlerUrl: httpUrlSchema,
        dashboardUrl: httpUrlSchema,
        members: z.array(stackMemberSchema)
    })
    .strict()

export type MemberRole = z.infer<typeof memberRoleSchema>
export type StackMember = z.infer<typeof stackMemberSchema>
export type StackDescriptor = z.infer<typeof stackDescriptorSchema>

/**
 * The two installable instances this app ships as (`eas.json`'s `member-a`/`member-b` profiles,
 * `app.config.ts`'s `EXPO_PUBLIC_MEMBER_ID`). A stack has no notion of "member-a" - its members
 * are named by the testbed that deployed them - so this app picks its member positionally: index 0
 * for `member-a`, index 1 for `member-b`.
 */
export const MEMBER_IDS = ["member-a", "member-b"] as const
export type MemberId = (typeof MEMBER_IDS)[number]

function isMemberId(value: string): value is MemberId {
    return MEMBER_IDS.some((id) => id === value)
}

// No default: Metro inlines this at bundle time, and a default silently ships the wrong org. An
// install built for member-b whose bundle fell back to member-a calls itself Org 1 everywhere,
// with nothing on screen to say so.
const rawMemberId = process.env.EXPO_PUBLIC_MEMBER_ID
if (rawMemberId === undefined || !isMemberId(rawMemberId)) {
    throw new Error(
        `EXPO_PUBLIC_MEMBER_ID must be one of ${MEMBER_IDS.join(", ")}, got ${rawMemberId === undefined ? "nothing" : `"${rawMemberId}"`}. ` +
            "Set it on every build and on every Metro start: EXPO_PUBLIC_MEMBER_ID=member-b yarn workspace network-member-app start"
    )
}
export const memberId = rawMemberId

/** Thrown by `parseStackDescriptor` and `buildMemberConfig` for input a person pasted, scanned, or fetched. */
export class StackConfigError extends Error {}

export function parseStackDescriptor(raw: string): StackDescriptor {
    let json: unknown
    try {
        json = JSON.parse(raw)
    } catch {
        throw new StackConfigError("that's not valid JSON")
    }

    const parsed = stackDescriptorSchema.safeParse(json)
    if (!parsed.success) {
        throw new StackConfigError(parsed.error.issues[0]?.message ?? "doesn't match the stack.json shape")
    }
    return parsed.data
}

function looksLikeUrl(raw: string): boolean {
    return /^https?:\/\//i.test(raw)
}

/** A loaded stack plus this org's own member server token. */
export interface Pairing {
    stack: StackDescriptor
    memberServerToken: string
}

const NOT_A_PAIRING_LINK =
    "that's the stack's public QR - scan this org's pairing QR from the terminal running yarn stack"

/** Parses `org=<index>&token=<token>` by hand, since Hermes lacks `URLSearchParams`. */
function parsePairingFragment(fragment: string): { index: number; token: string } | null {
    const fields: Record<string, string> = {}
    for (const part of fragment.split("&")) {
        const at = part.indexOf("=")
        if (at <= 0) continue
        try {
            fields[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1))
        } catch {
            return null // malformed %-escape
        }
    }
    const index = /^\d+$/.test(fields.org ?? "") ? Number(fields.org) : NaN
    return Number.isInteger(index) && fields.token ? { index, token: fields.token } : null
}

/** Resolves `<dashboard>/stack.json#org=<i>&token=<t>`, fetching only the fragment-less URL so the token stays on the phone. */
export async function resolvePairing(raw: string, id: MemberId): Promise<Pairing> {
    const trimmed = raw.trim()
    const hash = trimmed.indexOf("#")
    if (!looksLikeUrl(trimmed) || hash < 0) throw new StackConfigError(NOT_A_PAIRING_LINK)
    const pairing = parsePairingFragment(trimmed.slice(hash + 1))
    if (!pairing) throw new StackConfigError(NOT_A_PAIRING_LINK)
    // Refuse another org's link before fetching anything.
    if (pairing.index !== MEMBER_IDS.indexOf(id)) {
        throw new StackConfigError(
            `this pairing QR is for ${MEMBER_IDS[pairing.index] ?? `org ${pairing.index}`}, and this app is ${id}`
        )
    }

    const url = trimmed.slice(0, hash)
    let response: { ok: boolean; status: number; text(): Promise<string> }
    try {
        response = await fetch(url)
    } catch {
        throw new StackConfigError(`fetching ${url} failed`)
    }
    if (!response.ok) throw new StackConfigError(`fetching ${url} failed with status ${response.status}`)
    return { stack: parseStackDescriptor(await response.text()), memberServerToken: pairing.token }
}

/** `MemberConfig.registry.verifyingContract` is the `IdentityRegistry` - the contract a registration signature is over. */
export function buildMemberConfig(
    { stack, memberServerToken }: Pairing,
    id: MemberId,
    displayName: string
): MemberConfig {
    const member = stack.members[MEMBER_IDS.indexOf(id)]
    if (!member) {
        throw new StackConfigError(`this stack has no member for ${id}`)
    }

    return {
        networkId: member.networkId,
        displayName,
        serverUrl: member.serverUrl,
        registry: { chainId: stack.chainId, verifyingContract: stack.identityRegistry },
        memberServerToken
    }
}

export const STORAGE_KEY = "network-member-app.stack"

const pairingSchema = z.object({ stack: stackDescriptorSchema, memberServerToken: z.string().min(1) }).strict()

/** Throws on anything but `{ stack, memberServerToken }`, so `App` clears it and returns to Setup. */
export async function loadStoredPairing(): Promise<Pairing | null> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    let json: unknown
    try {
        json = JSON.parse(raw)
    } catch {
        throw new StackConfigError("that's not valid JSON")
    }
    const parsed = pairingSchema.safeParse(json)
    if (!parsed.success) {
        throw new StackConfigError("this app was set up for an older stack - scan this org's pairing QR again")
    }
    return parsed.data
}

export async function storePairing(pairing: Pairing): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pairing))
}

export async function clearStoredPairing(): Promise<void> {
    await AsyncStorage.removeItem(STORAGE_KEY)
}
