import typescript from "@rollup/plugin-typescript"
import cleanup from "rollup-plugin-cleanup"
import { dts } from "rollup-plugin-dts"

const external = /^zod/

/** @type {import('rollup').RollupOptions[]} */
const config = [
    {
        input: "src/index.ts",
        output: [
            { file: "dist/index.js", format: "es", sourcemap: false },
            { file: "dist/index.cjs", format: "cjs", sourcemap: false }
        ],
        external,
        plugins: [
            typescript({ tsconfig: "./tsconfig.json", declaration: false, declarationDir: undefined }),
            cleanup({ comments: "jsdoc" })
        ]
    },
    {
        input: "src/web.ts",
        output: [
            { file: "dist/web.js", format: "es", sourcemap: false },
            { file: "dist/web.cjs", format: "cjs", sourcemap: false }
        ],
        external,
        plugins: [
            typescript({ tsconfig: "./tsconfig.json", declaration: false, declarationDir: undefined }),
            cleanup({ comments: "jsdoc" })
        ]
    },
    {
        input: "src/index.ts",
        output: [{ file: "types/index.d.ts", format: "es" }],
        external,
        plugins: [dts()]
    },
    {
        input: "src/web.ts",
        output: [{ file: "types/web.d.ts", format: "es" }],
        external,
        plugins: [dts()]
    }
]

export default config
