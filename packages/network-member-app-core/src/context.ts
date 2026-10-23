import type { Hex20, Hex32, LinkClient } from "@coordination-network/user-app-link"
import type { MemberHooks, MemberPolicy, SubjectIdentity } from "./business"
import type {
    DeliverOutcome,
    EnrolOutcome,
    IssueOutcome,
    MembershipOutcome,
    RevokeOutcome,
    VerifyOutcome
} from "./outcomes"
import type { MemberServerClient, PresentationStatus } from "./server/client"
import { deliver } from "./flows/deliver"
import { enrol } from "./flows/enrol"
import { issue } from "./flows/issue"
import { membershipStatus } from "./flows/membership-status"
import { revoke } from "./flows/revoke"
import { verify } from "./flows/verify"
import {
    startPresentation,
    presentationStatus,
    cancelPresentation,
    type PresentationChallenge
} from "./flows/presentation"
import type { VerifyInput } from "./flows/verify"

export interface MemberConfig {
    networkId: Hex32
    displayName: string
    /** No trailing slash: this package's own server client and link-param URL helpers both append a leading-slash path directly. */
    serverUrl: string
    registry: { chainId: number; verifyingContract: Hex20 }
    /** What this member's revoke, membership, registration and deliver routes ask for. */
    memberServerToken: string
}

export interface MemberContext {
    config: MemberConfig
    link: LinkClient
    server: MemberServerClient
    policy: MemberPolicy
    hooks?: MemberHooks
}

export interface MemberFlows {
    enrol(): Promise<EnrolOutcome>
    issue(input: { subject: SubjectIdentity }): Promise<IssueOutcome>
    deliver(input: { networkId: Hex32 }): Promise<DeliverOutcome>
    startPresentation(input: { programme: string; country: string }): Promise<PresentationChallenge>
    presentationStatus(requestId: string): Promise<PresentationStatus>
    cancelPresentation(requestId: string): Promise<200 | 409>
    verify(input: VerifyInput): Promise<VerifyOutcome>
    revoke(input: { credentialId: string }): Promise<RevokeOutcome>
    membershipStatus(): Promise<MembershipOutcome>
}

/** Binds each flow's free function (in `./flows/*`, testable on their own) to one context. */
export function createMemberFlows(ctx: MemberContext): MemberFlows {
    const reportedPresentations = new Set<string>()
    return {
        enrol: () => enrol(ctx),
        issue: (input) => issue(ctx, input),
        deliver: (input) => deliver(ctx, input),
        startPresentation: (input) => startPresentation(ctx, input),
        presentationStatus: (id) => presentationStatus(ctx, id, reportedPresentations),
        cancelPresentation: (id) => cancelPresentation(ctx, id),
        verify: (input) => verify(ctx, input),
        revoke: (input) => revoke(ctx, input),
        membershipStatus: () => membershipStatus(ctx)
    }
}
