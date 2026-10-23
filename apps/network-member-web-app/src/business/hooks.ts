export interface BusinessHooks {
    onEvent(event: string, details: unknown): void
}

/**
 * Reports completed flow names without putting credentials or verification
 * records in the browser console. Pass `includeDetails` only in a local,
 * disposable development build whose console output is safe to retain.
 */
export function createLoggingHooks(includeDetails = false): BusinessHooks {
    return {
        onEvent(event, details) {
            if (includeDetails) console.info(`[member] ${event}`, details)
            else console.info(`[member] ${event}`)
        }
    }
}

export const loggingHooks: BusinessHooks = createLoggingHooks()
