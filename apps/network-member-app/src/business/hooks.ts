import type { FlowName, MemberHooks } from "@coordination-network/network-member-app-core"

export type ActivityTone = "info" | "error"

export interface ActivityEntry {
    id: number
    at: number
    tone: ActivityTone
    flow: FlowName
    message: string
}

type ActivityListener = (entries: ActivityEntry[]) => void

let entries: ActivityEntry[] = []
let nextId = 1
const listeners = new Set<ActivityListener>()

function record(tone: ActivityTone, flow: FlowName, message: string): void {
    entries = [{ id: nextId++, at: Date.now(), tone, flow, message }, ...entries]
    for (const listener of listeners) listener(entries)
}

/** Lets a screen render the log and stay in sync as flows add to it. Called once, from `ActivityScreen`. */
export function subscribeToActivity(listener: ActivityListener): () => void {
    listeners.add(listener)
    listener(entries)
    return () => listeners.delete(listener)
}

export function clearActivity(): void {
    entries = []
    for (const listener of listeners) listener(entries)
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * The reference `MemberHooks`: appends every flow outcome to the in-app activity log. A real
 * member wires these to its own analytics or logging instead - the flows above never change.
 * No `onDelivered`: this app never calls `flows.deliver()` (flow 6 is out of scope here; `deliver`
 * stays in `network-member-app-core` only for the Node testbed). No `onRevoked` either, for the
 * same reason: revoking is the dashboard's, where the operator can see every credential this org
 * issued. This member's own admission by governance no longer runs from this app, so it has no
 * governance hooks either.
 */
export const hooks: MemberHooks = {
    onEnrolled(outcome) {
        record(
            "info",
            "enrol",
            outcome.status === "alreadyRegistered" ? "this person was already registered" : "registered a new person"
        )
    },

    onIssued() {
        record("info", "issue", "issued a credential")
    },

    onVerified(outcome) {
        record(
            outcome.status === "verified" ? "info" : "error",
            "verify",
            outcome.status === "verified" ? "verified a presentation" : "rejected a presentation"
        )
    },

    onError(event) {
        record("error", event.flow, `${event.flow}: failed at ${event.stage} - ${describeError(event.error)}`)
    }
}
