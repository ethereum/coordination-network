import path from "node:path"
import type { LoadContext } from "@docusaurus/types"
import type { RuleSetRule } from "webpack"
import docsPlugin, { type PluginOptions, validateOptions } from "@docusaurus/plugin-content-docs"
import { contentDirs, importedFiles, repoRoot } from "../doc-slugs"

// The docs plugin is rooted at the repo, so scope its file watching and MDX loader to the content folders and imports
export default async function docs(context: LoadContext, options: PluginOptions) {
    const plugin = await docsPlugin(context, options)
    const repoWidePrefix = `${path.resolve(context.siteDir, options.path)}/**/`

    return {
        ...plugin,
        getPathsToWatch: () =>
            plugin.getPathsToWatch!().flatMap((pattern) =>
                pattern.startsWith(repoWidePrefix)
                    ? contentDirs.map(({ dir }) => `${dir}/**/${pattern.slice(repoWidePrefix.length)}`)
                    : [pattern]
            ),
        configureWebpack: (...args: Parameters<NonNullable<typeof plugin.configureWebpack>>) => {
            const config = plugin.configureWebpack!(...args)
            const mdxRule = config?.module?.rules?.find(
                (rule): rule is RuleSetRule => !!rule && typeof rule === "object" && rule.include !== undefined
            )

            if (!config || !mdxRule) {
                throw new Error("Docs MDX loader rule not found, check src/plugins/docs.ts after upgrading Docusaurus")
            }

            mdxRule.include = [
                ...contentDirs.map(({ dir }) => `${dir}${path.sep}`),
                ...importedFiles.map((file) => path.join(repoRoot, file))
            ]

            return config
        }
    }
}

export { validateOptions }
