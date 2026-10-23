import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

function publishedWorkspaces(): string[] {
    const output = execSync("yarn workspaces list --json --no-private", { encoding: "utf8" })

    return output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line).location as string)
}

async function main() {
    for (const location of publishedWorkspaces()) {
        const filePath = `${location}/package.json`

        const content = JSON.parse(readFileSync(filePath, "utf8"))

        if (content.stableVersion) {
            delete content.stableVersion

            writeFileSync(filePath, `${JSON.stringify(content, null, 4)}\n`, "utf8")
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
