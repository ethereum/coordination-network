const DAY_SECONDS = 86_400

export function validateCredentialValiditySeconds(validitySeconds: number): void {
    if (!Number.isSafeInteger(validitySeconds) || validitySeconds < DAY_SECONDS) {
        throw new RangeError("credential validity must be at least one day")
    }
}

/** Give credentials issued on one UTC day the same signed validity window. */
export function issuanceValidityWindow(
    nowSeconds: number,
    validitySeconds: number
): {
    validFrom: number
    validUntil: number
} {
    validateCredentialValiditySeconds(validitySeconds)
    const validFrom = Math.floor(nowSeconds / DAY_SECONDS) * DAY_SECONDS
    const validUntil = validFrom + Math.ceil(validitySeconds / DAY_SECONDS) * DAY_SECONDS - 1
    return { validFrom, validUntil }
}
