import { OperatorError } from "./operator-error"

/** Provider URLs carry their API key in the path or query, and viem puts the URL in its error
 *  messages. Anything that reaches a dashboard or a peer keeps only the origin. */
export function redactUrls(message: string): string {
    return message.replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
        try {
            return new URL(url).origin
        } catch {
            return "<url>"
        }
    })
}

/** What the terminal gets for an error: an operator error's message, otherwise the stack, with
 *  every URL cut to its origin. Never the error object itself, which carries the full URL on `url`. */
export function describeError(error: unknown): string {
    if (error instanceof OperatorError) return redactUrls(error.message)
    return redactUrls(error instanceof Error ? (error.stack ?? error.message) : String(error))
}
