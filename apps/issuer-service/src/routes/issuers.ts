import { Router } from "express"
import { IssuerSetBacking } from "../issuer-set"

export interface IssuersRouterDeps {
    issuerSet: IssuerSetBacking
}

export function issuersRouter({ issuerSet }: IssuersRouterDeps): Router {
    const router = Router()

    router.get("/v1/issuers", async (_req, res) => {
        const { leaves, root, blockNumber } = await issuerSet.read()
        res.json({
            leaves: leaves.map((leaf) => leaf.toString()),
            root: root.toString(),
            blockNumber: blockNumber.toString(),
            approvedIssuerSet: issuerSet.address ?? null
        })
    })

    return router
}
