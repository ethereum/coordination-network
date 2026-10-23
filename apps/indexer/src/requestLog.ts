import type { Request, Response } from "express"
import type pino from "pino"
import pinoHttp from "pino-http"

/**
 * One log entry per HTTP request: what was called, when, from where, and whether it
 * succeeded. Mounted before authentication, so a rejected caller leaves a record too.
 */
export function createHttpRequestLog(logger: pino.Logger) {
    return pinoHttp<Request, Response>({
        logger,
        redact: ["req.headers.authorization"], // remove auth token from logs
        customProps: (request) => {
            const networkIdInBody = request.body?.networkId
            const networkIdInqueryString = request.query.networkId

            return {
                kind: "access",
                // pino-http would record the proxy that forwarded the request, not the machine that sent it
                clientIp: request.ip,
                networkId: networkIdInBody ?? networkIdInqueryString
            }
        }
    })
}
