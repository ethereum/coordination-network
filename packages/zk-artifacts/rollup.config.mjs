import typescript from "@rollup/plugin-typescript"
import cleanup from "rollup-plugin-cleanup"
import { dts } from "rollup-plugin-dts"

const external = [/^node:/, /^@noir-lang/]

const plugins = () => [
    typescript({ tsconfig: "./tsconfig.json", declaration: false, declarationDir: undefined }),
    cleanup({ comments: "jsdoc" })
]

/** @type {import('rollup').RollupOptions[]} */
const config = [
    {
        input: "src/index.ts",
        output: [
            { file: "dist/index.js", format: "es", sourcemap: false },
            { file: "dist/index.cjs", format: "cjs", sourcemap: false }
        ],
        external,
        plugins: plugins()
    },
    // The browser entry resolves its artifacts through `import.meta.url`, which a CommonJS
    // bundle cannot carry, so it ships as ES modules only.
    {
        input: "src/browser.ts",
        output: [{ file: "dist/browser.js", format: "es", sourcemap: false }],
        external,
        plugins: plugins()
    },
    {
        input: "src/index.ts",
        output: [{ file: "types/index.d.ts", format: "es" }],
        external,
        plugins: [dts()]
    },
    {
        input: "src/browser.ts",
        output: [{ file: "types/browser.d.ts", format: "es" }],
        external,
        plugins: [dts()]
    }
]

export default config
