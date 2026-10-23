import { RequestHandler, Router } from "express"
import { z } from "zod"
import { Hex32 } from "@coordination-network/credential"
import { NetworkMemberClientError, deliverToStealth } from "@coordination-network/network-member-client"
import type { DeliverToStealthPorts } from "@coordination-network/network-member-client"
import { describeError } from "../log"
import { deliveryBody } from "../schemas"

export interface DeliveriesRouterDeps {
    issuerNetworkId: Hex32
    ports?: DeliverToStealthPorts
    /** Only whoever holds this member's token may spend the paymaster deposit, or `MEMBER_PRIVATE_KEY`'s gas on the direct path. */
    requireMemberServerToken: RequestHandler
    rateLimit: RequestHandler
}

export function deliveriesRouter({
    issuerNetworkId,
    ports,
    requireMemberServerToken,
    rateLimit
}: DeliveriesRouterDeps): Router {
    const router = Router()

    router.post("/v1/deliveries", requireMemberServerToken, rateLimit, async (req, res) => {
        if (!ports) {
            res.status(503).json({ error: "deliveries not configured", code: "NOT_CONFIGURED" })
            return
        }

        const body = deliveryBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: z.prettifyError(body.error) })
            return
        }

        try {
            const result = await deliverToStealth(
                { memberNetworkId: issuerNetworkId, recipientNetworkId: body.data.networkId },
                ports
            )
            res.status(201).json({ status: "announced", txHash: result.txHash })
        } catch (error) {
            if (error instanceof NetworkMemberClientError && error.code === "MEMBER_NOT_APPROVED") {
                res.status(403).json({ error: error.message, code: error.code })
                return
            }
            if (
                error instanceof NetworkMemberClientError &&
                (error.code === "RECIPIENT_NOT_REGISTERED" || error.code === "INVALID_META_STEALTH_ADDRESS")
            ) {
                // Not distinguished: a malformed address would tell the caller the recipient is registered.
                res.status(422).json({ error: "delivery refused", code: "DELIVERY_REFUSED" })
                return
            }
            // Any other failure (the announce transaction itself reverting or failing to submit)
            // is reported the same way: never the recipient's networkId, which is the request
            // body this route must not echo.
            console.warn("delivery failed", describeError(error))
            res.status(502).json({ error: "announce failed", code: "ANNOUNCE_FAILED" })
        }
    })

    return router
}
