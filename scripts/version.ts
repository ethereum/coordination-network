import { execSync } from "node:child_process"

/**
 * Releases every published workspace on one shared version.
 */
async function main() {
    const version = process.argv[2]

    if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/.test(version)) {
        throw new Error(`expected a semver version, for example "yarn version:bump 0.2.0", got "${version ?? ""}"`)
    }

    const status = execSync("git status --porcelain", { encoding: "utf8" }).trim()

    if (status !== "") {
        throw new Error(
            `the working tree must be clean: "git commit -am" below would sweep unrelated changes into the release commit\n${status}`
        )
    }

    // Record the bump for every published workspace, then write them all at once.
    execSync(`yarn workspaces foreach -A --no-private version -d ${version}`, { stdio: "inherit" })
    execSync("yarn version apply --all", { stdio: "inherit" })

    // Runs in its own process because the script exits on completion, and it
    // chains format:write so the rewritten manifests stay prettier-clean.
    execSync("yarn remove:stable-version-field", { stdio: "inherit" })

    execSync(`NO_HOOK=1 git commit -am "chore: v${version}"`, { stdio: "inherit" })
    execSync(`git tag v${version}`, { stdio: "inherit" })

    console.info(`\nTagged v${version}. Push it to publish: git push && git push origin v${version}`)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
