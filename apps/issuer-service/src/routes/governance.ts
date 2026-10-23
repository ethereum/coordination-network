import { NextFunction, RequestHandler, Response, Router } from "express"
import { z } from "zod"
import { CredentialSigner } from "@coordination-network/credential"
import { ActivityLog } from "../activity"
import { GovernancePorts, GovernanceRevertError } from "../governance-ports"
import { hex32 } from "../schemas"
import { membershipSnapshot } from "./status"

const admissionBody = z.object({ networkId: hex32 })

/** This router's own paths, keyed by what each does rather than its URL. The status page's
 *  Membership panel reads this map too, so its script and the router never drift apart. */
export const GOVERNANCE_ROUTES = {
    membership: "/v1/membership",
    requestToJoin: "/v1/membership/requests",
    pendingRequests: "/v1/governance/requests",
    admit: "/v1/governance/admissions",
    registerIdentity: "/v1/membership/identity",
    publishIssuerKey: "/v1/membership/issuer-key"
} as const

export interface GovernanceRouterDeps {
    governance: GovernancePorts
    signer: CredentialSigner
    activityLog: ActivityLog
    /** Applied to each route below: all six act as this organisation, admission included. Per
     *  route rather than `router.use`, which would answer for every request reaching this router
     *  and so refuse the open routes mounted after it. */
    requireMemberServerToken: RequestHandler
}

/** Answers 409 for the one revert a route expects from its own write; anything else, including a
 *  `GovernanceRevertError` of a different code, still falls through to the terminal 500 handler. */
function answerExpectedRevert(
    res: Response,
    next: NextFunction,
    error: unknown,
    expected: string,
    message: string
): void {
    if (error instanceof GovernanceRevertError && error.code === expected) {
        res.status(409).json({ error: message, code: expected })
        return
    }
    next(error)
}

export function governanceRouter({
    governance,
    signer,
    activityLog,
    requireMemberServerToken
}: GovernanceRouterDeps): Router {
    const router = Router()

    router.get(GOVERNANCE_ROUTES.membership, requireMemberServerToken, async (_req, res) => {
        const snapshot = await membershipSnapshot(governance)

        res.json({
            networkId: governance.networkId,
            authAddress: governance.authAddress,
            governanceSigner: governance.governanceSigner,
            metaStealthAddress: governance.metaStealthAddress,
            ...snapshot
        })
    })

    router.post(GOVERNANCE_ROUTES.requestToJoin, requireMemberServerToken, async (_req, res, next) => {
        try {
            const txHash = await governance.requestToJoin()
            activityLog.append("governance", "requested to join the network", { txHash })
            res.status(201).json({ txHash })
        } catch (error) {
            answerExpectedRevert(res, next, error, "AlreadyApproved", "already approved")
        }
    })

    router.get(GOVERNANCE_ROUTES.pendingRequests, requireMemberServerToken, async (_req, res) => {
        const requests = await governance.pendingJoinRequests()
        res.json({
            requests: requests.map((request) => ({
                memberNetworkId: request.memberNetworkId,
                semaphoreCommitment: request.semaphoreCommitment.toString(),
                governanceSigner: request.governanceSigner,
                metadataURI: request.metadataURI ?? ""
            }))
        })
    })

    router.post(GOVERNANCE_ROUTES.admit, requireMemberServerToken, async (req, res) => {
        const body = admissionBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: z.prettifyError(body.error) })
            return
        }

        const outcome = await governance.admitMember(body.data.networkId)
        switch (outcome.status) {
            case "admitted":
                activityLog.append("governance", `admitted ${body.data.networkId} to the network`, {
                    networkId: body.data.networkId,
                    execTxHash: outcome.execTxHash
                })
                res.json({
                    status: outcome.status,
                    safeTxHash: outcome.safeTxHash,
                    approveTxHash: outcome.approveTxHash,
                    execTxHash: outcome.execTxHash,
                    approvals: outcome.approvals,
                    threshold: outcome.threshold,
                    message: `admitted with ${outcome.approvals} of ${outcome.threshold} approvals`
                })
                return
            case "awaitingApprovals": {
                const message = `waiting for another org: ${outcome.approvals} of ${outcome.threshold} approvals in`
                activityLog.append("governance", `approved admitting ${body.data.networkId}; ${message}`, {
                    networkId: body.data.networkId,
                    safeTxHash: outcome.safeTxHash
                })
                res.json({
                    status: outcome.status,
                    safeTxHash: outcome.safeTxHash,
                    approveTxHash: outcome.approveTxHash,
                    approvals: outcome.approvals,
                    threshold: outcome.threshold,
                    message
                })
                return
            }
            case "alreadyApproved":
                res.status(409).json({ error: "already approved" })
                return
            case "noPendingRequest":
                res.status(404).json({ error: "no pending request" })
        }
    })

    router.post(GOVERNANCE_ROUTES.registerIdentity, requireMemberServerToken, async (_req, res, next) => {
        try {
            const txHash = await governance.registerIdentity()
            activityLog.append("governance", "registered its member identity", { txHash })
            res.status(201).json({ txHash })
        } catch (error) {
            answerExpectedRevert(res, next, error, "NotApproved", "not approved yet")
        }
    })

    router.post(GOVERNANCE_ROUTES.publishIssuerKey, requireMemberServerToken, async (_req, res, next) => {
        try {
            const [x, y] = await signer.getPublicKey()
            const { txHash, leaf, root } = await governance.publishIssuerKey(x, y)
            activityLog.append("governance", "published its credential signing key", {
                txHash,
                leaf: leaf.toString()
            })
            res.status(201).json({ txHash, leaf: leaf.toString(), root: root.toString() })
        } catch (error) {
            answerExpectedRevert(res, next, error, "IssuerKeyAlreadyPublished", "issuer key already published")
        }
    })

    return router
}
