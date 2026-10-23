/**
 * The signatures a Safe of `memberCount` network members must require: a majority, one more than
 * half. Five members need three, eight need five.
 *
 * The authoritative copy of this rule is on chain, in `NetworkMemberGovernance.governanceThreshold`,
 * which every admission and removal sets the Safe's threshold from. This is the same expression for
 * off-chain use: checking that a Safe is configured correctly, and reporting what a pending operation
 * will change the threshold to. No call carries a threshold, so nothing depends on this value being
 * right.
 *
 * @param memberCount How many members the Safe has owners for, after the change.
 * @returns The required number of approvals.
 */
export function governanceThreshold(memberCount: number): number {
    if (!Number.isInteger(memberCount) || memberCount < 1) {
        throw new Error(`A member count must be a positive integer, got ${memberCount}`)
    }

    return Math.floor(memberCount / 2) + 1
}
