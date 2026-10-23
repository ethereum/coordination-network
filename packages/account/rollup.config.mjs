import typescript from "@rollup/plugin-typescript"
import cleanup from "rollup-plugin-cleanup"
import { dts } from "rollup-plugin-dts"

const external = /^(@semaphore-protocol|viem)/

/** @type {import('rollup').RollupOptions[]} */
const config = [
    {
        input: "src/index.ts",
        output: [
            {
                file: "dist/index.js",
                format: "es",
                sourcemap: false
            },
            {
                file: "dist/index.cjs",
                format: "cjs",
                sourcemap: false
            }
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
    }
]

export default config
