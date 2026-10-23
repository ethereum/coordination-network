import { test } from "node:test"
import { runNetworkMemberWalkthrough } from "../scripts/network-member/walkthrough.ts"

/**
 * Runs the demo and fails if any step does not do what the walkthrough says it does.
 *
 * The walkthrough checks its own claims against the chain as it goes, so running it is the assertion:
 * a step that stopped registering a member, or a threshold that stopped moving with the member count,
 * throws rather than printing a success. This is the CI guard for the demo's own code, and it is all
 * this app needs to test.
 *
 * The contracts' own behaviour is not retested here. `packages/contracts/test` covers authorisation,
 * the governance rule and the atomicity of each operation against a real Safe, and
 * `packages/network-member-governance` covers the transaction building. Restating those in TypeScript
 * would leave two places to update for one change, and the weaker one would be this.
 */
test("the network member walkthrough runs end to end", { timeout: 120_000 }, async () => {
    await runNetworkMemberWalkthrough()
})
