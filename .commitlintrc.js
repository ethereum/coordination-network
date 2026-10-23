const fs = require("node:fs")
const path = require("node:path")

// Read a directory's entries, tolerating its absence: before the first
// workspace package is committed, `packages/` (and in principle `apps/`) may
// not exist yet, and an unguarded readdirSync would throw ENOENT and break
// every commitlint invocation on a fresh checkout.
function readDirSafe(dir) {
    const resolved = path.resolve(__dirname, dir)
    return fs.existsSync(resolved) ? fs.readdirSync(resolved) : []
}

const packages = readDirSafe("packages")
const apps = readDirSafe("apps")

module.exports = {
    extends: ["@commitlint/config-conventional"],
    prompt: {
        scopes: [...packages, ...apps],
        markBreakingChangeMode: true,
        allowCustomIssuePrefix: false,
        allowEmptyIssuePrefix: false,
        issuePrefixes: [
            {
                value: "re",
                name: "re: ISSUES related"
            }
        ]
    }
}
