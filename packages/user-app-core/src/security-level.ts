import type { SecurityLevel } from "@coordination-network/user-app-link"

// UNKNOWN ranks with SOFTWARE: a keystore that cannot say is trusted no more than one that admits it.
const RANK: Record<SecurityLevel, number> = { STRONGBOX: 2, TRUSTED_ENVIRONMENT: 1, SOFTWARE: 0, UNKNOWN: 0 }

export function meetsSecurityLevel(level: SecurityLevel, minimum: SecurityLevel): boolean {
    return RANK[level] >= RANK[minimum]
}
