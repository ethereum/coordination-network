import type { AttestedLevel } from "./attestation"

/** The levels an issuer can be configured to require. SOFTWARE turns key attestation off. */
export const MINIMUM_DEVICE_SECURITY_LEVELS = ["SOFTWARE", "TRUSTED_ENVIRONMENT", "STRONGBOX"] as const
export type MinimumDeviceSecurityLevel = (typeof MINIMUM_DEVICE_SECURITY_LEVELS)[number]

const RANK: Record<MinimumDeviceSecurityLevel, number> = { STRONGBOX: 2, TRUSTED_ENVIRONMENT: 1, SOFTWARE: 0 }

export function meetsMinimumSecurityLevel(level: AttestedLevel, minimum: MinimumDeviceSecurityLevel): boolean {
    return RANK[level] >= RANK[minimum]
}
