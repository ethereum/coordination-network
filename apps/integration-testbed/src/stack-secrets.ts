import { timingSafeEqual } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bytesToHex, randomBytes } from "@noble/hashes/utils"
import type { Hex32 } from "@coordination-network/credential"
import type { StackDescriptor } from "./serve"

/** Secrets `yarn stack` keeps out of the served `stack.json`. */
export interface StackSecrets {
    /** Per-run key for the dashboard's `/api/orgs/*` relay. */
    dashboardKey: string
    /** Each org's member server token, by `networkId`. */
    memberServerTokens: Record<Hex32, string>
}

export function buildStackSecrets(members: readonly { networkId: Hex32; memberServerToken: string }[]): StackSecrets {
    return {
        // Random per run, so nothing checked in can derive it.
        dashboardKey: bytesToHex(randomBytes(32)),
        memberServerTokens: Object.fromEntries(
            members.map((member) => [member.networkId, member.memberServerToken])
        ) as Record<Hex32, string>
    }
}

export function memberServerHeaders(
    secrets: StackSecrets,
    member: { name: string; networkId: Hex32 }
): Record<string, string> {
    const token = secrets.memberServerTokens[member.networkId]
    if (!token) throw new Error(`no member server token for ${member.name}`)
    return { authorization: `Bearer ${token}` }
}

export function dashboardHeaders(secrets: StackSecrets): Record<string, string> {
    return { authorization: `Bearer ${secrets.dashboardKey}` }
}

/** Timing-safe bearer check, mirroring `apps/issuer-service/src/auth.ts`. */
export function hasDashboardKey(header: string | undefined, key: string): boolean {
    const presented = /^Bearer (.+)$/.exec(header ?? "")?.[1]
    if (presented === undefined) return false
    const bytes = Buffer.from(presented, "utf8")
    const expected = Buffer.from(key, "utf8")
    // timingSafeEqual throws on unequal lengths, so length, the only thing leaked, is compared first.
    return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}

/** One org's pairing link; the token sits in the fragment, which HTTP clients never send. */
export function pairingUrl(stack: StackDescriptor, secrets: StackSecrets, index: number): string {
    const member = stack.members[index]
    if (!member) throw new Error(`no member at index ${index}`)
    const token = secrets.memberServerTokens[member.networkId]
    if (!token) throw new Error(`no member server token for ${member.name}`)
    return `${stack.dashboardUrl}/stack.json#org=${index}&token=${token}`
}

export function operatorDashboardUrl(stack: StackDescriptor, secrets: StackSecrets): string {
    return `${stack.dashboardUrl}/#key=${secrets.dashboardKey}`
}

export interface StackSecretsFile {
    dashboardKey: string
    operatorDashboardUrl: string
    members: { name: string; networkId: Hex32; memberServerToken: string; pairingUrl: string }[]
}

/** Contents of `stack.secrets.json`, for re-pairing a phone or answering a status page's token prompt. */
export function stackSecretsFile(stack: StackDescriptor, secrets: StackSecrets): StackSecretsFile {
    return {
        dashboardKey: secrets.dashboardKey,
        operatorDashboardUrl: operatorDashboardUrl(stack, secrets),
        members: stack.members.map((member, index) => ({
            name: member.name,
            networkId: member.networkId,
            memberServerToken: secrets.memberServerTokens[member.networkId],
            pairingUrl: pairingUrl(stack, secrets, index)
        }))
    }
}

/** Writes `stack.secrets.json` (0600) into a fresh 0700 temp dir, outside the repo Vite serves at `/@fs/`. */
export function writeStackSecrets(stack: StackDescriptor, secrets: StackSecrets, parent = tmpdir()): string {
    const path = join(mkdtempSync(join(parent, "coordination-network-stack-")), "stack.secrets.json")
    writeFileSync(path, `${JSON.stringify(stackSecretsFile(stack, secrets), null, 2)}\n`, { mode: 0o600 })
    return path
}
