import { themes } from "prism-react-renderer"
import type { Config } from "@docusaurus/types"
import type * as Preset from "@docusaurus/preset-classic"
import type { Options as DocsOptions } from "@docusaurus/plugin-content-docs"
import {
    type DocEntry,
    docDescription,
    docSlug,
    importedFiles,
    packageEntries,
    privacyDisclosure,
    serviceEntries
} from "./src/doc-slugs"
import repoLinks from "./src/remark/repo-links"

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const lightCodeTheme = themes.oneLight
const darkCodeTheme = themes.oneDark

// Doc ids follow the file path relative to the plugin root
const docId = (file: string) => file.replace(/\.md$/, "")
const docItem = (file: string) => ({ type: "doc" as const, id: docId(file) })
const entryItem = ({ label, file, children, description }: DocEntry) =>
    children.length
        ? {
              type: "category" as const,
              label,
              description,
              link: { type: "doc" as const, id: docId(file) },
              items: children.map(docItem)
          }
        : { ...docItem(file), label }

const config: Config = {
    title: "Coordination Network",
    tagline: "Decentralized, zero-knowledge identity and private payment rails for networks of organizations.",
    favicon: "img/network-mark.svg",

    // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
    future: {
        v4: true // Improve compatibility with the upcoming Docusaurus v4
    },

    url: "https://coordination-network.ethereum.foundation",
    baseUrl: "/",

    organizationName: "ethereum",
    projectName: "coordination-network",
    trailingSlash: false,

    onBrokenLinks: "throw",

    markdown: {
        // Parse .md files as CommonMark so the specs need no MDX escaping
        format: "detect",
        mermaid: true,
        // The docs are read from the repo root, so derive routes relative to each content folder
        parseFrontMatter: async (params) => {
            const result = await params.defaultParseFrontMatter(params)
            const slug = docSlug(params.filePath, result.frontMatter)
            const description = docDescription(params.filePath, result.frontMatter)

            if (slug) result.frontMatter.slug = slug
            if (description) result.frontMatter.description = description

            return result
        }
    },

    themes: [
        "@docusaurus/theme-mermaid",
        [
            "@easyops-cn/docusaurus-search-local",
            {
                hashed: true,
                // Matches the docs plugin, which serves at the site root
                docsRouteBasePath: "/",
                indexBlog: false,
                indexPages: false
            }
        ]
    ],

    i18n: {
        defaultLocale: "en",
        locales: ["en"]
    },

    presets: [
        [
            "classic",
            {
                // Provided by the plugin in src/plugins/docs.ts
                docs: false,
                blog: false,
                theme: {
                    customCss: "./src/css/custom.css"
                }
            } satisfies Preset.Options
        ]
    ],

    plugins: [
        [
            "./src/plugins/docs.ts",
            {
                // Serve the docs at the site root, with no separate landing page
                routeBasePath: "/",
                // Read from the repo root so the sidebar can include the top-level specs folder
                path: "../..",
                include: ["apps/docs/docs/**/*.{md,mdx}", "specs/*.md", ...importedFiles],
                sidebarPath: "./sidebars.ts",
                // Places the specs category after the top-level pages, before the other categories, and adds the
                // imported docs: the privacy disclosure under Security, the rest as categories at the end
                sidebarItemsGenerator: async ({ defaultSidebarItemsGenerator, ...args }) => {
                    const items = await defaultSidebarItemsGenerator(args)

                    if (args.item.dirName !== "apps/docs/docs") return items

                    const generate = (dirName: string) =>
                        defaultSidebarItemsGenerator({ ...args, item: { ...args.item, dirName } })
                    const index = items.findIndex((item) => item.type === "category")

                    items.splice(index === -1 ? items.length : index, 0, {
                        type: "category",
                        label: "Specs",
                        items: await generate("specs")
                    })

                    return [
                        ...items.map((item) =>
                            item.type === "category" &&
                            item.items.some(
                                (child) => child.type === "doc" && child.id.startsWith("apps/docs/docs/security/")
                            )
                                ? { ...item, items: [...item.items, docItem(privacyDisclosure)] }
                                : item
                        ),
                        {
                            type: "category",
                            label: "Packages",
                            link: { type: "generated-index", slug: "/packages" },
                            items: packageEntries.map(entryItem)
                        },
                        { type: "category", label: "Services", items: serviceEntries.map(entryItem) }
                    ]
                },
                editUrl: ({ docPath }) => `https://github.com/ethereum/coordination-network/edit/main/${docPath}`,
                beforeDefaultRemarkPlugins: [repoLinks]
            } satisfies DocsOptions
        ],
        [
            // Writes llms.txt and llms-full.txt into the build, the machine-readable entry point agents look for
            "docusaurus-plugin-llms",
            {
                docsDir: [
                    { path: "docs", routeBasePath: "/", label: "Site" },
                    { path: "../../specs", routeBasePath: "specs", label: "Specs" }
                ],
                // Order of the site pages in llms.txt: these four first, then every other page in the plugin's default order
                includeOrder: [
                    "docs/intro.mdx",
                    "docs/architecture.mdx",
                    "docs/guides/integration.mdx",
                    "docs/glossary.mdx"
                ],
                excludeImports: true,
                removeDuplicateHeadings: true
            }
        ]
    ],

    themeConfig: {
        // Social media card
        image: "img/docusaurus-social-card.jpg",
        colorMode: {
            defaultMode: "light",
            respectPrefersColorScheme: true
        },
        navbar: {
            title: "Coordination Network",
            logo: {
                alt: "Coordination Network Logo",
                src: "img/network-mark.svg"
            },
            items: [
                { label: "Integration", to: "/guides/integration", position: "right" },
                { label: "Packages", to: "/packages", position: "right" },
                { label: "Contracts", to: "/deployed-contracts", position: "right" },
                {
                    label: "GitHub",
                    href: "https://github.com/ethereum/coordination-network",
                    position: "right"
                }
            ]
        },
        footer: {
            style: "light",
            links: [
                {
                    title: "Build",
                    items: [
                        { label: "Integration guide", to: "/guides/integration" },
                        { label: "Packages", to: "/packages" },
                        { label: "Sepolia demo", to: "/guides/sepolia-demo" }
                    ]
                },
                {
                    title: "Understand",
                    items: [
                        { label: "Privacy and security", to: "/security/privacy-and-security" },
                        { label: "Deployed contracts", to: "/deployed-contracts" }
                    ]
                },
                {
                    title: "Resources",
                    items: [
                        { label: "GitHub", href: "https://github.com/ethereum/coordination-network" },
                        { label: "Semaphore docs", href: "https://docs.semaphore.pse.dev/" },
                        { label: "Ethereum", href: "https://ethereum.org/" }
                    ]
                }
            ],
            copyright: `Copyright © ${new Date().getFullYear()} Ethereum Foundation.`
        },
        prism: {
            theme: lightCodeTheme,
            darkTheme: darkCodeTheme,
            additionalLanguages: ["solidity", "bash", "typescript"]
        }
    } satisfies Preset.ThemeConfig
}

export default config
