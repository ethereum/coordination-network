import type { ProofGenerator } from "@coordination-network/wallet"
import type { ZkPresentationInputs, ZkPresentationProof } from "@coordination-network/credential"

export class WorkerProofGenerator implements ProofGenerator {
    private sequence = 0
    constructor(private readonly reportElapsed: (milliseconds: number) => void = () => {}) {}

    generateProof(inputs: ZkPresentationInputs): Promise<ZkPresentationProof> {
        const worker = new Worker(new URL("./proof-worker.ts", import.meta.url), { type: "module" })
        const id = ++this.sequence
        return new Promise((resolve, reject) => {
            worker.onerror = (event) => {
                worker.terminate()
                reject(new Error(event.message))
            }
            worker.onmessage = (
                event: MessageEvent<{ id: number; proof?: ZkPresentationProof; elapsedMs?: number; error?: string }>
            ) => {
                if (event.data.id !== id) return
                worker.terminate()
                if (event.data.error || !event.data.proof)
                    reject(new Error(event.data.error ?? "worker returned no proof"))
                else {
                    this.reportElapsed(event.data.elapsedMs ?? 0)
                    resolve(event.data.proof)
                }
            }
            worker.postMessage({ id, inputs })
        })
    }
}
