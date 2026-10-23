import { getCredentialCircuit } from "@coordination-network/zk-artifacts/browser"
import {
    ZkCredentialProofSystem,
    type ZkCredentialCircuit,
    type ZkPresentationInputs
} from "@coordination-network/credential"

self.onmessage = async (event: MessageEvent<{ id: number; inputs: ZkPresentationInputs }>) => {
    const startedAt = performance.now()
    try {
        const circuit = (await getCredentialCircuit()) as ZkCredentialCircuit
        const system = await ZkCredentialProofSystem.create(circuit, { backend: { threads: 1 } })
        try {
            const proof = await system.generateProof(event.data.inputs)
            self.postMessage({ id: event.data.id, proof, elapsedMs: performance.now() - startedAt })
        } finally {
            await system.destroy()
        }
    } catch (error) {
        self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) })
    }
}
