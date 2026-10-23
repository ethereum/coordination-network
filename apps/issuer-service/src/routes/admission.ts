import { RequestHandler, Router } from "express"
import type { AdmissionPorts } from "../types"

export function admissionRouter(admission: AdmissionPorts, requireMemberServerToken: RequestHandler): Router {
    const router = Router()

    router.use("/v1/admission", requireMemberServerToken)

    router.get("/v1/admission", async (_req, res, next) => {
        try {
            res.json(await admission.status())
        } catch (error) {
            next(error)
        }
    })

    router.post("/v1/admission/request", async (_req, res, next) => {
        try {
            res.json(await admission.request())
        } catch (error) {
            next(error)
        }
    })

    router.post("/v1/admission/approve", async (_req, res, next) => {
        try {
            res.json(await admission.approve())
        } catch (error) {
            next(error)
        }
    })

    router.post("/v1/admission/leave", async (_req, res, next) => {
        try {
            res.json(await admission.leave())
        } catch (error) {
            next(error)
        }
    })

    return router
}
