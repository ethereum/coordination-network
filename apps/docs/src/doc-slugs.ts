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

export type DocEntry = { label: string; file: string; children: string[]; description?: string }

const npmScope = "@coordination-network/"
const packageChildren: Record<string, string[]> = {
    "packages/identity": ["packages/identity/DERIVATION.md"],
    "packages/contracts/src": ["packages/contracts/src/revocation/README.md"]
}

// One line per package for the /packages index cards, which otherwise cut the README's first paragraph short
const packageDescriptions: Record<string, string> = {
    account: "EIP-7702 accounts and Semaphore paymaster proofs for sponsored user operations",
    circuits: "Noir presentation circuit",
    contracts: "Solidity contracts: registries, governance, approved-issuer set and paymaster",
    credential: "Issues credentials and builds and verifies zero-knowledge presentations",
    "expo-identity-keystore": "Expo module for hardware-backed P-256 keys in the Android Keystore",
    identity: "Derives networkId and the user's keys on device, plus stealth address helpers",
    "issuer-set": "Approved-issuer tree and its membership proofs",
    "network-member-app-core": "Member app flows: enrol, issue, verify, revoke and membership status",
    "network-member-client": "Member server helpers: issue credentials and write to the registries",
    "network-member-governance": "Safe transactions that admit or remove a network member",
    "network-member-proof": "Semaphore proofs that authorise registry writes",
    "noir-prover-ffi": "React Native binding with the prebuilt Android library",
    "noir-prover-native": "Native prover for React Native",
    "revocation-registry": "Revocation tree with membership and non-membership proofs",
    "user-app-core": "User app engine: identity creation and the deep-link requests",
    "user-app-link": "Deep-link protocol between the user app and member apps",
    "user-client": "One-call onboarding: derive keys and build the signed registration request",
    wallet: "Holder SDK: credential storage, revocation sync and consent-gated presentations",
    "zk-artifacts": "Compiled credential circuit and its verification key"
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

        const label = pkg.name.replace(npmScope, "")

        return pkg.private
            ? []
            : [
                  {
                      label,
                      file: `${dir}/README.md`,
                      children: packageChildren[dir] ?? [],
                      description: packageDescriptions[label]
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

const entryDescriptions = new Map(
    packageEntries.flatMap(({ file, description }) => (description ? [[path.join(repoRoot, file), description]] : []))
)

// The index card description of an imported README, unless its front matter sets one
export function docDescription(filePath: string, frontMatter: Record<string, unknown>): string | undefined {
    return frontMatter.description === undefined ? entryDescriptions.get(filePath) : undefined
}

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
