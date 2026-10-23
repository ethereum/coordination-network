import { RequestHandler, Router } from "express"
import { NetworkMemberClientError, submitRegistration } from "@coordination-network/network-member-client"
import type { Sponsorship, SubmitRegistrationPorts } from "@coordination-network/network-member-client"
import { ActivityLog } from "../activity"
import { describeError } from "../log"
import { registrationBody } from "../schemas"
import type { MutableIssuancePolicy } from "../issuance-policy"

/** `Sponsorship`'s bigints as decimal strings: the wire format every issuer-service response uses for them. */
function serializeSponsorship(sponsorship: Sponsorship) {
    return {
        sender: sponsorship.sender,
        senderBalanceBefore: sponsorship.senderBalanceBefore.toString(),
        senderBalanceAfter: sponsorship.senderBalanceAfter.toString(),
        userOpHash: sponsorship.userOpHash,
        bundleTxHash: sponsorship.bundleTxHash,
        actualGasCost: sponsorship.actualGasCost.toString(),
        paymaster: sponsorship.paymaster,
        paymasterDepositBefore: sponsorship.paymasterDepositBefore.toString(),
        paymasterDepositAfter: sponsorship.paymasterDepositAfter.toString()
    }
}

/** Short caller-facing message per unavailable/rejected code; codes submitRegistration can't throw are absent. */
const UNAVAILABLE_MESSAGES: Partial<Record<NetworkMemberClientError["code"], string>> = {
    GROUP_MIRROR_UNAVAILABLE: "registration group unavailable",
    REGISTRY_UNAVAILABLE: "registry unavailable",
    MEMBER_NOT_IN_GROUP: "network member not admitted to the registration group",
    REGISTRATION_REJECTED: "registration rejected"
}

export interface RegistrationsRouterDeps {
    ports?: SubmitRegistrationPorts
    activityLog: ActivityLog
    /** Only whoever holds this member's token may spend: its own `SUBMITTER_PRIVATE_KEY` gas, or, sponsored, the network's shared paymaster deposit. */
    requireMemberServerToken: RequestHandler
    rateLimit: RequestHandler
    issuancePolicy?: MutableIssuancePolicy
}

export function registrationsRouter({
    ports,
    activityLog,
    requireMemberServerToken,
    rateLimit,
    issuancePolicy
}: RegistrationsRouterDeps): Router {
    const router = Router()

    router.post("/v1/registrations", requireMemberServerToken, rateLimit, async (req, res, next) => {
        if (!ports) {
            res.status(503).json({ error: "registration not configured", code: "NOT_CONFIGURED" })
            return
        }

        const body = registrationBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: "malformed registration request" })
            return
        }

        try {
            const result = await submitRegistration(body.data, ports)
            if (result.status === "submitted") {
                issuancePolicy?.approve(result.networkId)
                // The feed is public, so entries carry no ref: the sender, userOpHash and txHash
                // all resolve in one eth_getLogs to the bundle transaction's IdentityRegistered
                // log, which names the user's network id and would link this member to every user
                // it relayed for — exactly what the fresh stealth sender and random proof scope
                // exist to prevent.
                activityLog.append(
                    "registration",
                    result.sponsorship
                        ? "registered a network id, gas paid by the paymaster"
                        : "registered a network id",
                    undefined,
                    "ok"
                )
                res.status(201).json({
                    status: "submitted",
                    txHash: result.txHash,
                    ...(result.sponsorship !== undefined
                        ? { sponsorship: serializeSponsorship(result.sponsorship) }
                        : {})
                })
            } else {
                if (result.matchesRequest) issuancePolicy?.approve(result.networkId)
                activityLog.append("registration", "found an existing registration", undefined, "existing")
                res.status(200).json({
                    status: "alreadyRegistered",
                    metaStealthAddress: result.metaStealthAddress,
                    matchesRequest: result.matchesRequest
                })
            }
        } catch (error) {
            if (!(error instanceof NetworkMemberClientError)) {
                next(error)
                return
            }
            if (error.code === "INVALID_REGISTRATION_REQUEST") {
                console.warn(error.code)
                res.status(400).json({ error: "invalid registration request", code: error.code })
                return
            }
            const message = UNAVAILABLE_MESSAGES[error.code]
            if (!message) {
                next(error)
                return
            }
            console.warn(error.code, describeError(error), describeError(error.cause))
            activityLog.append("registration", `registration failed: ${error.code}`, undefined, "failed")
            res.status(503).json({ error: message, code: error.code })
        }
    })

    return router
}
