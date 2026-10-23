import type { ApprovalScope, Hex32 } from "@coordination-network/credential"

/** The member-owned decision that authorises issuance and supplies the scope to sign. */
export interface IssuancePolicy {
    decideIssuance(subjectNetworkId: Hex32): Promise<ApprovalScope | null>
}

export interface MutableIssuancePolicy extends IssuancePolicy {
    approve(subjectNetworkId: Hex32): void
}

/** Member-local approvals: global enrolment alone never authorises issuance. */
export function memberIssuancePolicy(approvalScope: ApprovalScope): MutableIssuancePolicy {
    const approvedSubjects = new Set<Hex32>()
    return {
        approve(subjectNetworkId) {
            approvedSubjects.add(subjectNetworkId)
        },
        async decideIssuance(subjectNetworkId) {
            return approvedSubjects.has(subjectNetworkId) ? approvalScope : null
        }
    }
}

/** Fail-closed default for servers that do not configure an issuance policy. */
export const denyAllIssuancePolicy: IssuancePolicy = { decideIssuance: async () => null }
