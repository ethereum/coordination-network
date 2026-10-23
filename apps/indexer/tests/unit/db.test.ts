import { createPool } from "../../src/db.ts"
import { logger } from "../../src/logger.ts"

test("createPool survives an idle client's error event instead of crashing the process", async () => {
    // nothing listens on this port, so the pool never connects and no database is needed
    const pool = createPool("postgres://user:pass@127.0.0.1:1/does-not-matter")
    const errorLog = jest.spyOn(logger, "error").mockImplementation(() => {})

    expect(() => pool.emit("error", new Error("simulated idle client error"))).not.toThrow()
    // the pool error handler should still log
    expect(errorLog).toHaveBeenCalledTimes(1)

    errorLog.mockRestore()
    await pool.end()
})
