import { join } from "node:path"

/** Jest runs from the repository root, so the path cannot be relative to the working directory. */
export default function loadTestEnv() {
    process.loadEnvFile(join(__dirname, "../.env.test"))
}
