import { config } from "./config.ts"
import { logger } from "./logger.ts"
import { startIndexer } from "./server.ts"

async function main() {
    const { app, stop } = await startIndexer()

    const listener = app.listen(config.port, () => {
        logger.info({ port: config.port }, "indexer listening")
    })

    // a container gets SIGTERM before it is killed. stop() waits for the scan in flight.
    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.once(signal, async () => {
            logger.info({ signal }, "shutting down")
            listener.close()
            await stop()
        })
    }
}

main()
