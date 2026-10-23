import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export const repoRoot = path.resolve(__dirname, "../../..")

// Folders the docs plugin reads (it is rooted at the repo) and the route each one is served under
export const siteDocsDir = path.join(repoRoot, "apps/docs/docs")
export const contentDirs = [
    { dir: siteDocsDir, route: "" },
    { dir: path.join(repoRoot, "specs"), route: "/specs" }
]

export const privacyDisclosure = "packages/contracts/docs/privacy-disclosure.md"

export type DocEntry = { label: string; file: string; children: string[] }

const npmScope = "@coordination-network/"
const packageChildren: Record<string, string[]> = {
    "packages/identity": ["packages/identity/DERIVATION.md"],
    "packages/contracts/src": ["packages/contracts/src/revocation/README.md"]
}

// Like Yarn workspaces, skip folders without a package.json. The published contracts package is in src/, not the
// private Foundry workspace at packages/contracts. The native bindings are nested under noir-prover-native
const packageDirs = [
    ...readdirSync(path.join(repoRoot, "packages"))
        .map((name) => `packages/${name}`)
        .filter((dir) => existsSync(path.join(repoRoot, dir, "package.json"))),
    "packages/contracts/src",
    "packages/noir-prover-native/rust/MoproReactNativeBindings"
]

export const packageEntries: DocEntry[] = packageDirs
    .flatMap((dir) => {
        const pkg = JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"))

        return pkg.private
            ? []
            : [
                  {
                      label: pkg.name.replace(npmScope, ""),
                      file: `${dir}/README.md`,
                      children: packageChildren[dir] ?? []
                  }
              ]
    })
    .sort((a, b) => a.label.localeCompare(b.label))

export const serviceEntries: DocEntry[] = [
    { label: "Issuer service", file: "apps/issuer-service/README.md", children: [] },
    { label: "Indexer", file: "apps/indexer/README.md", children: ["apps/indexer/DEPLOYMENT.md"] }
]

// Docs outside the content folders, rendered in place. Concrete paths keep the loader out of nested node_modules
export const importedFiles = [
    privacyDisclosure,
    ...[...packageEntries, ...serviceEntries].flatMap(({ file, children }) => [file, ...children])
]
export const importedPaths = new Set(importedFiles.map((file) => path.join(repoRoot, file)))

const stripNumberPrefix = (name: string) => name.replace(/^\d+\s*[-_.]+\s*(?=[^-_.\s])/, "")

// Mirrors Docusaurus's default slug rules relative to each content folder (the repo root for imports), lowercased
export function docSlug(filePath: string, frontMatter: Record<string, unknown>): string | undefined {
    if (frontMatter.slug !== undefined) return undefined

    const roots = importedPaths.has(filePath) ? [...contentDirs, { dir: repoRoot, route: "" }] : contentDirs

    for (const { dir, route } of roots) {
        const relativePath = path.relative(dir, filePath)

        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue

        const segments = relativePath.split(path.sep).map(stripNumberPrefix)
        const fileName = segments.pop()!.replace(/\.mdx?$/, "")
        const isCategoryIndex = ["index", "readme", segments.at(-1)?.toLowerCase()].includes(fileName.toLowerCase())

        if (typeof frontMatter.id === "string") segments.push(frontMatter.id)
        else if (!isCategoryIndex) segments.push(fileName)

        return `${route}/${segments.join("/")}`.toLowerCase()
    }

    return undefined
}
