import { warnIfSteppingIgnored } from "../shared/narrate.ts"
import { runNetworkMemberWalkthrough } from "../network-member/walkthrough.ts"

/**
 * The command line entry point for the network member walkthrough.
 *
 * Thin on purpose: the walkthrough itself is a plain function, so the test suite can run the same flow
 * without going through a process.
 */
const unknown = process.argv.slice(2).filter((argument) => argument !== "--step")
if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(", ")}. The only one is --step`)

warnIfSteppingIgnored()

runNetworkMemberWalkthrough().catch((error: unknown) => {
    process.exitCode = 1
    console.error(error)
})
