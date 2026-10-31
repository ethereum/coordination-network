import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
    plugins: [
        react(),
        {
            name: "local-stack-descriptor",
            configureServer(server) {
                server.middlewares.use(async (request, response, next) => {
                    if (request.url === "/health") {
                        response.setHeader("content-type", "application/json")
                        response.end(JSON.stringify({ ok: true, name: "Network Member Web App" }))
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
