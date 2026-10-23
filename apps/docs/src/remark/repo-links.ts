import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { contentDirs, importedPaths, repoRoot, siteDocsDir } from "../doc-slugs"

const repoUrl = "https://github.com/ethereum/coordination-network"

type Node = { type: string; url?: string; children?: Node[] }

const isSiteFile = (absolute: string) =>
    importedPaths.has(absolute) || contentDirs.some(({ dir }) => !path.relative(dir, absolute).startsWith(".."))

// Points relative links in specs and imported docs at the site when the target is imported, else at GitHub
export default function repoLinks() {
    return (tree: Node, file: { path?: string }) => {
        if (!file.path || !path.relative(siteDocsDir, file.path).startsWith("..")) return

        const sourceDir = path.dirname(file.path)

        const visit = (node: Node) => {
            if (
                (node.type === "link" || node.type === "definition") &&
                node.url &&
                !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(node.url)
            ) {
                const [target, hash] = node.url.split("#")
                const absolute = path.resolve(sourceDir, target)

                const readme = path.join(absolute, "README.md")

                if (importedPaths.has(readme)) {
                    // Docusaurus resolves the file link to its route
                    const relative = path.relative(sourceDir, readme).split(path.sep).join("/")

                    node.url = hash ? `${relative}#${hash}` : relative
                } else if (!isSiteFile(absolute)) {
                    const kind = existsSync(absolute) && statSync(absolute).isDirectory() ? "tree" : "blob"
                    const repoPath = path.relative(repoRoot, absolute).split(path.sep).join("/")
                    const url = `${repoUrl}/${kind}/main/${repoPath}`

                    node.url = hash ? `${url}#${hash}` : url
                }
            }

            node.children?.forEach(visit)
        }

        visit(tree)
    }
}
