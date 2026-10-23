/** What the status page's recent-activity panel groups entries by. */
export type ActivityKind = "registration" | "credential" | "revocation" | "verification" | "governance"

export interface ActivityEntry {
    at: number
    kind: ActivityKind
    message: string
    refs?: Record<string, string>
    /** Set on registration, credential, and verification entries so counts can tell a successful
     *  write from an existing-registration or rejected one; other kinds leave it unset. */
    outcome?: "ok" | "existing" | "failed"
}

/** An entry without its refs, for readers outside this server. The refs name transactions and
 *  addresses; the dashboard narrates what happened and has no business reprinting them. */
export type ActivityExcerpt = Pick<ActivityEntry, "at" | "kind" | "message">

export function excerpt({ at, kind, message }: ActivityEntry): ActivityExcerpt {
    return { at, kind, message }
}

const MAX_ENTRIES = 200

/** In-memory ring of the last {@link MAX_ENTRIES} activity entries, oldest dropped first. */
export class ActivityLog {
    private readonly entries: ActivityEntry[] = []

    append(
        kind: ActivityKind,
        message: string,
        refs?: Record<string, string>,
        outcome?: ActivityEntry["outcome"]
    ): void {
        this.entries.push({ at: Date.now(), kind, message, refs, outcome })
        if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    }

    /** The most recent entries, newest first, capped at `limit`. */
    recent(limit = MAX_ENTRIES): ActivityEntry[] {
        return this.entries.slice(-limit).reverse()
    }
}
