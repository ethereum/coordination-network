import { Router } from "express"
import type { AttestationVerifier } from "../attestation"

export function healthRouter(deviceAttestation?: AttestationVerifier): Router {
    const router = Router()

    router.get("/health", (_req, res) => {
        res.json(
            deviceAttestation
                ? { ok: true, deviceAttestationStatusList: deviceAttestation.statusListState() }
                : { ok: true }
        )
    })

    return router
}
