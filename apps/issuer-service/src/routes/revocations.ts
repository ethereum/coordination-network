import { Router } from "express"
import { RevocationBacking } from "../revocation"

export function revocationsRouter(revocation: RevocationBacking): Router {
    const router = Router()

    // Refreshed, not served as it stands: this is the tree a wallet builds its non-membership
    // proof against, and this server's mirror only moves on this server's own writes. Serving it
    // unrefreshed hands the wallet a tree with every other member's revocations missing, which
    // fails its check against the root it reads from chain.
    // `/v1/issuers` reads its tree through to the chain per request for the same reason.
    router.get("/v1/revocations/snapshot", async (_req, res) => {
        await revocation.refresh()
        res.json({
            registryAddress: revocation.registryAddress,
            // A hint, not part of any verification: a client that would rather read the tree off
            // the revocation service itself than import this snapshot needs the id to do it.
            registryId: revocation.registryId === null ? null : revocation.registryId.toString(),
            root: revocation.mirror.root.toString(),
            snapshot: revocation.mirror.export()
        })
    })

    return router
}
