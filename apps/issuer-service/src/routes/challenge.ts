import { RequestHandler, Router } from "express"
import { bytesToHex } from "@noble/hashes/utils"
import { z } from "zod"
import { challengeBody } from "../schemas"
import { NonceStore } from "../stores/nonce-store"

export function challengeRouter(nonces: NonceStore, rateLimit: RequestHandler): Router {
    const router = Router()

    router.post("/v1/challenge", rateLimit, async (req, res) => {
        const body = challengeBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: z.prettifyError(body.error) })
            return
        }
        const { challengeId, nonce, expiresAt } = await nonces.issue(body.data.subjectNetworkId)
        // Unprefixed, unlike every other hex field in the protocol. Callers that feed this
        // straight into `issuance.bind`, whose schema demands a 0x prefix, have to add one.
        res.json({ challengeId, nonce: bytesToHex(nonce), expiresAt })
    })

    return router
}
