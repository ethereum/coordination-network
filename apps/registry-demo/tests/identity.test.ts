import { test } from "node:test"
import { runIdentityWalkthrough } from "../scripts/identity/walkthrough.ts"

/**
 * Runs the identity registry demo and fails if any step does not do what the walkthrough says.
 *
 * The first run downloads Semaphore's proving artifacts, which is why the timeout is generous; later
 * runs prove in well under a second from the cache.
 */
test("the identity registry walkthrough runs end to end", { timeout: 300_000 }, async () => {
    await runIdentityWalkthrough()
})
