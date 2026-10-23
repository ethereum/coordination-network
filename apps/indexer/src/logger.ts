import pino from "pino"
import { config } from "./config.ts"

/**
 * One JSON log entry per event, written to stdout for the hosting platform to collect and
 * store.
 *
 * The service writes two kinds of log entry. Access entries, tagged `kind: "access"`, record
 * one HTTP request each — this allows logging to track who called what.
 * Access entries are written at log level `info`, which is why `LOG_LEVEL`
 * in config.ts accepts nothing less explicit — a less explicit level would drop this audit trail.
 */
export const logger = pino({
    level: config.logLevel,
    ...(config.logFormat === "pretty" && { transport: { target: "pino-pretty" } })
})
