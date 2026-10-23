import { test } from "node:test"
import { runMemberAndIdentityWalkthrough } from "../scripts/member-and-identity/walkthrough.ts"

/** Runs the combined demo and fails if any step does not do what the walkthrough says. */
test("the member and identity registries work together", { timeout: 300_000 }, async () => {
    await runMemberAndIdentityWalkthrough()
})
