import { middleTruncate } from "@coordination-network/app-ui"
import type { Brand } from "@coordination-network/app-ui"
import type { ConsentSummary } from "@coordination-network/user-app-core"
import type { Caller } from "@coordination-network/user-app-link"
import type { StackDescriptor } from "./config"

export interface ResolvedMember {
    name: string
    brand: Brand
}

/** `buildConsentSummary`'s row for the callback, which both screens below single out. */
export const CALLBACK_LABEL = "Callback"

/** The callback a summary carries: what `resolveMember` matches on, and the row `Consent` leads
 *  with when nothing vouches for the caller. */
export function callbackOf(summary: ConsentSummary): string {
    return summary.details.find(({ label }) => label === CALLBACK_LABEL)?.value ?? ""
}

/**
 * The network member a calling app is, or null: the declared name must belong to the member whose
 * scheme the callback uses, since the OS routes the response by that scheme and verifies nothing the
 * caller declares.
 */
export function resolveMember(stack: StackDescriptor | null, caller: Caller, callback: string): ResolvedMember | null {
    const separator = callback.indexOf("://")
    // `null`, not a slice of the whole string: a callback with no scheme must match no member,
    // including one the stack lists without a scheme of its own.
    const callbackScheme = separator === -1 ? null : callback.slice(0, separator).toLowerCase()
    const member = stack?.members.find(({ name, scheme }) => name === caller.name && scheme === callbackScheme)
    return member === undefined ? null : { name: member.name, brand: member.brand }
}

/** The member that issued a held credential, or null when the loaded stack has never heard of it. */
export function resolveIssuer(stack: StackDescriptor | null, issuerNetworkId: string): ResolvedMember | null {
    const member = stack?.members.find(({ networkId }) => networkId === issuerNetworkId)
    return member === undefined ? null : { name: member.name, brand: member.brand }
}

/** `0x1111…1111`, matching `KeyValue`'s own truncation, for an org the stack cannot name. */
export function shortNetworkId(networkId: string): string {
    return middleTruncate(networkId)
}
