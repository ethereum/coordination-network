import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

export default defineConfig({
    // noir_js and zk-artifacts locate their WASM modules and circuit relative to their own ESM files.
    // Pre-bundling rewrites that base URL into .vite/deps without copying the files, so keep both as ESM.
    optimizeDeps: { exclude: ["@noir-lang/noir_js", "@coordination-network/zk-artifacts"] },
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
