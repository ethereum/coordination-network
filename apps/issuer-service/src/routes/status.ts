import { Router } from "express"
import { ApprovedIssuerSet, CredentialSigner } from "@coordination-network/credential"
import { ActivityExcerpt, ActivityLog, excerpt } from "../activity"
import { GovernancePorts } from "../governance-ports"
import { IssuerSetBacking } from "../issuer-set"
import { MembershipSnapshot, PeerOrg, StatusPageData, buildStatusPage } from "../status/page"

/** How many activity entries `/v1/status` carries, enough for the dashboard to say what just
 *  happened without turning into a second feed. */
const RECENT_ACTIVITY = 5

/** The `/v1/status` response body: a member's own status page data, minus the fields only the
 *  HTML page needs, plus a short ref-free excerpt of the activity feed. */
export type MemberStatusSnapshot = Omit<StatusPageData, "activity" | "dashboardUrl" | "peers"> & {
    recentActivity: ActivityExcerpt[]
}

export interface StatusRouterDeps {
    governance: GovernancePorts
    signer: CredentialSigner
    issuerSet: IssuerSetBacking
    activityLog: ActivityLog
    displayName: string
    dashboardUrl?: string
    peers?: PeerOrg[]
    accent?: string
}

export async function membershipSnapshot(governance: GovernancePorts): Promise<MembershipSnapshot> {
    const [approved, request, safe, identity, issuerKeys] = await Promise.all([
        governance.isApproved(),
        governance.joinRequestFor(),
        governance.safeState(),
        governance.identityOf(),
        governance.issuerKeysOf()
    ])
    return {
        status: approved ? "approved" : request ? "requested" : "none",
        safe: { address: governance.safeAddress, threshold: safe.threshold, owners: safe.owners },
        identityRegistered: identity !== null,
        issuerKeyPublished: issuerKeys.length > 0
    }
}

export function statusRouter({
    governance,
    signer,
    issuerSet,
    activityLog,
    displayName,
    dashboardUrl,
    peers,
    accent
}: StatusRouterDeps): Router {
    const router = Router()

    const snapshot = async (): Promise<MemberStatusSnapshot> => {
        const [membership, [x, y], issuerSetState] = await Promise.all([
            membershipSnapshot(governance),
            signer.getPublicKey(),
            issuerSet.read()
        ])
        const ownLeaf = ApprovedIssuerSet.leafOf([x, y])
        const recent = activityLog.recent()
        // Only an approved member can admit one, so a candidate or an unaffiliated server never
        // pays for this read.
        const pendingRequests =
            membership.status === "approved"
                ? (await governance.pendingJoinRequests()).map((request) => ({
                      memberNetworkId: request.memberNetworkId,
                      metadataURI: request.metadataURI ?? ""
                  }))
                : []

        return {
            networkId: governance.networkId,
            displayName,
            authAddress: governance.authAddress,
            membership,
            pendingRequests,
            issuerKey: { x: x.toString(), y: y.toString(), published: issuerSetState.leaves.includes(ownLeaf) },
            issuerSet: {
                address: issuerSet.address ?? null,
                root: issuerSetState.root.toString(),
                size: issuerSetState.size
            },
            counts: {
                registrations: recent.filter((entry) => entry.kind === "registration" && entry.outcome === "ok").length,
                existingRegistrations: recent.filter(
                    (entry) => entry.kind === "registration" && entry.outcome === "existing"
                ).length,
                credentials: recent.filter((entry) => entry.kind === "credential" && entry.outcome === "ok").length,
                revocations: recent.filter((entry) => entry.kind === "revocation").length,
                verifications: recent.filter((entry) => entry.kind === "verification" && entry.outcome === "ok").length,
                rejectedVerifications: recent.filter(
                    (entry) => entry.kind === "verification" && entry.outcome === "failed"
                ).length
            },
            recentActivity: recent.slice(0, RECENT_ACTIVITY).map(excerpt)
        }
    }

    router.get("/", async (_req, res) => {
        const data = await snapshot()
        res.type("html").send(buildStatusPage({ ...data, activity: activityLog.recent(), dashboardUrl, peers, accent }))
    })

    router.get("/v1/status", async (_req, res) => {
        res.json(await snapshot())
    })

    router.get("/v1/activity", (_req, res) => {
        res.json({ entries: activityLog.recent() })
    })

    return router
}
