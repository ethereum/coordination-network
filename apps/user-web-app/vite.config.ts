import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

export default defineConfig({
    // noir_js locates its two WASM modules relative to its own ESM files. Pre-bundling rewrites
    // that base URL into .vite/deps without copying the WASM files, so keep the package as ESM.
    optimizeDeps: { exclude: ["@noir-lang/noir_js"] },
    resolve: {
        alias: [
            {
                find: "@coordination-network/user-app-link/web",
                replacement: resolve(import.meta.dirname, "../../packages/user-app-link/src/web.ts")
            },
            {
                find: "@coordination-network/zk-artifacts/browser",
                replacement: resolve(import.meta.dirname, "../../packages/zk-artifacts/src/browser.ts")
            },
            ...[
                "credential",
                "identity",
                "issuer-set",
                "revocation-registry",
                "user-app-link",
                "user-client",
                "wallet"
            ].map((name) => ({
                find: `@coordination-network/${name}`,
                replacement: resolve(import.meta.dirname, `../../packages/${name}/src/index.ts`)
            }))
        ]
    },
    worker: { format: "es" },
    server: { port: 4173, strictPort: true },
    plugins: [
        react(),
        {
            name: "local-stack-descriptor",
            configureServer(server) {
                server.middlewares.use(async (request, response, next) => {
                    if (request.url === "/health") {
                        response.setHeader("content-type", "application/json")
                        response.end(JSON.stringify({ ok: true, name: "User Web App" }))
                        return
                    }
                    if (request.url !== "/stack.json") return next()
                    try {
                        response.setHeader("content-type", "application/json")
                        response.end(
                            await readFile(resolve(import.meta.dirname, "../integration-testbed/stack.json"), "utf8")
                        )
                    } catch (error) {
                        next(error as Error)
                    }
                })
            }
        }
    ],
    build: { target: "es2020" }
})
