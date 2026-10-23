export interface ApprovalScope {
    programme: string
    country: string
}
export interface ProgrammeProfile extends ApprovalScope {
    programmeName: string
    countryName: string
}
export interface MemberPolicy {
    decideEnrolment(networkId: string): Promise<boolean>
    decideIssuance(networkId: string): Promise<ApprovalScope | null>
}

const programmes: Record<string, ProgrammeProfile> = {
    alpha: {
        programme: "standard-access",
        programmeName: "Standard Access",
        country: "ZZZ",
        countryName: "Demo Country"
    },
    beta: {
        programme: "extended-access",
        programmeName: "Extended Access",
        country: "XAA",
        countryName: "Demo Country A"
    },
    eve: {
        programme: "priority-access",
        programmeName: "Priority Access",
        country: "XAB",
        countryName: "Demo Country B"
    }
}

export function programmeForMember(memberName: string): ProgrammeProfile {
    return (
        programmes[memberName.toLowerCase()] ?? {
            programme: "demo-programme",
            programmeName: "Demo Programme",
            country: "ZZZ",
            countryName: "Demo Country"
        }
    )
}

export function policyForMember(memberName: string): MemberPolicy {
    const { programme, country } = programmeForMember(memberName)
    return {
        async decideEnrolment() {
            return true
        },
        async decideIssuance() {
            return { programme, country }
        }
    }
}
