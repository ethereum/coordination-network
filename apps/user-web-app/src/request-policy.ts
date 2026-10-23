const BACKGROUND_OPERATIONS = new Set<string>()

/** Only explicitly allowlisted background work may proceed without a person's review. */
export function requiresUserReview(operation: string): boolean {
    return !BACKGROUND_OPERATIONS.has(operation)
}
