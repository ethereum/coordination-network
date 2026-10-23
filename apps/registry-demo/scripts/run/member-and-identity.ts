import { warnIfSteppingIgnored } from "../shared/narrate.ts"
import { runMemberAndIdentityWalkthrough } from "../member-and-identity/walkthrough.ts"

/** The command line entry point for the combined walkthrough. */
const unknown = process.argv.slice(2).filter((argument) => argument !== "--step")
if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(", ")}. The only one is --step`)

warnIfSteppingIgnored()

runMemberAndIdentityWalkthrough().catch((error: unknown) => {
    process.exitCode = 1
    console.error(error)
})
