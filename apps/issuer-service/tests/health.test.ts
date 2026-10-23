import assert from "node:assert/strict"
import { test } from "node:test"
import { InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { buildServer, type ServerDeps } from "../src/server"
import { testVerifier } from "./attestation-fixtures"

const ISSUER_ID = `0x${"ff".repeat(32)}` as const

async function health(deps: Partial<ServerDeps>): Promise<unknown> {
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer: new LocalCredentialSigner("issuer-service-health"),
        resolver: new InMemoryResolver(),
        ...deps
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        return await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    } finally {
        listener.close()
    }
}

test("/health reports the attestation status list's state", async () => {
    assert.deepEqual(await health({ deviceAttestation: await testVerifier() }), {
        ok: true,
        deviceAttestationStatusList: "fresh"
    })
    for (const unavailable of ["stale", "never-fetched"] as const) {
        assert.deepEqual(await health({ deviceAttestation: await testVerifier({ unavailable }) }), {
            ok: true,
            deviceAttestationStatusList: unavailable
        })
    }
    assert.deepEqual(await health({}), { ok: true, deviceAttestationStatusList: "never-fetched" })
})

test("/health leaves the list out when the minimum is SOFTWARE", async () => {
    assert.deepEqual(await health({ minDeviceSecurityLevel: "SOFTWARE", deviceAttestation: await testVerifier() }), {
        ok: true
    })
})
