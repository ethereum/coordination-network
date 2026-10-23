import { execFileSync } from "child_process"
import { join } from "path"
import { describe, it, expect } from "@jest/globals"

const RUST_DIR = join(__dirname, "..", "rust")

/**
 * `scripts/build-android.sh` reapplies this patch to `build.gradle` after every `mopro build`
 * (see that script for why). The contract this pins: the committed `build.gradle` has to already
 * be what the next `build-android.sh` run would produce. Editing only `build.gradle` looks like
 * it works, but a real build overwrites it from mopro's pristine output and silently drops the
 * edit — the patch is the only edit that survives.
 */
describe("build-gradle-abis.patch", () => {
    it("reverses cleanly against the committed build.gradle", () => {
        expect(() =>
            execFileSync("git", ["apply", "--reverse", "--check", "../scripts/build-gradle-abis.patch"], {
                cwd: RUST_DIR
            })
        ).not.toThrow()
    })
})
