import { p256 } from "@noble/curves/nist.js"
import { MemoryStore } from "@coordination-network/wallet"
import type { ZkPresentationInputs, ZkPresentationProof } from "@coordination-network/credential"
import type { LinkOp } from "@coordination-network/user-app-link"
import { createUserAppService } from "../../src/service"
import type {
    ConsentSummary,
    MemberDirectory,
    PresentationReview,
    RevocationAuthority,
    RootAuthority,
    UserAppPorts,
    UserAppService
} from "../../src/types"
import { FakeHttpClient } from "./fake-http"
import { issuerKeyLeavesOf } from "./member-stack"
import { createTestDeviceKey, type TestDeviceKey } from "./test-device-key"

export class RecordingProofGenerator {
    readonly inputs: ZkPresentationInputs[] = []

    async generateProof(inputs: ZkPresentationInputs): Promise<ZkPresentationProof> {
        this.inputs.push(inputs)
        return { proof: Uint8Array.from([1, 2, 3, 4]), publicInputs: ["1", "2", "3"] }
    }
}

export interface ServiceHarness {
    ports: UserAppPorts
    service: UserAppService
    store: MemoryStore
    devicePrivateKey: Uint8Array
    deviceKey: TestDeviceKey
    proofGenerator: RecordingProofGenerator
    http: FakeHttpClient
    consentSeen: ConsentSummary[]
    consentAnswer: { value: boolean }
    reviewSeen: PresentationReview[]
    reviewAnswer: { value: boolean }
    progressSeen: { op: LinkOp; step: string }[]
    /** What the network's one revocation registry says about any commitment; `null` is nobody to ask. */
    revocationAnswer: { value: boolean | null }
    /** Replace `read` to make the chain answer something else, or fail. */
    directory: { read: MemberDirectory["issuerKeyLeavesOf"] }
    /** Point `read` at a member stack's `chainRoots()`; it throws until a test says what the chain holds. */
    roots: { read: RootAuthority["currentRoots"] }
    now: { value: number }
}

export function createServiceHarness(
    options: {
        devicePrivateKey?: Uint8Array
        http?: FakeHttpClient
        /** `null` leaves the port off altogether, as an app with no stack configured does. */
        revocations?: RevocationAuthority | null
    } = {}
): ServiceHarness {
    const devicePrivateKey = options.devicePrivateKey ?? p256.utils.randomSecretKey()
    const store = new MemoryStore()
    const deviceKey = createTestDeviceKey(devicePrivateKey)
    const proofGenerator = new RecordingProofGenerator()
    const http = options.http ?? new FakeHttpClient()
    const consentSeen: ConsentSummary[] = []
    const consentAnswer = { value: true }
    const reviewSeen: PresentationReview[] = []
    const reviewAnswer = { value: true }
    const progressSeen: { op: LinkOp; step: string }[] = []
    const revocationAnswer: { value: boolean | null } = { value: false }
    const directory = { read: issuerKeyLeavesOf as MemberDirectory["issuerKeyLeavesOf"] }
    const roots: ServiceHarness["roots"] = {
        read: async () => {
            throw new Error("no chain roots set for this harness")
        }
    }
    const now = { value: Date.now() }
    const revocations =
        options.revocations === undefined ? { isRevoked: async () => revocationAnswer.value } : options.revocations

    const ports: UserAppPorts = {
        store,
        deviceKey,
        proofGenerator,
        http,
        consent: async (summary) => {
            consentSeen.push(summary)
            return consentAnswer.value
        },
        review: async (summary) => {
            reviewSeen.push(summary)
            return reviewAnswer.value
        },
        directory: { issuerKeyLeavesOf: (networkId) => directory.read(networkId) },
        roots: { currentRoots: () => roots.read() },
        progress: (op, step) => progressSeen.push({ op, step }),
        ...(revocations === null ? {} : { revocations }),
        now: () => now.value
    }

    return {
        ports,
        service: createUserAppService(ports),
        store,
        devicePrivateKey,
        deviceKey,
        proofGenerator,
        http,
        consentSeen,
        consentAnswer,
        reviewSeen,
        reviewAnswer,
        progressSeen,
        revocationAnswer,
        directory,
        roots,
        now
    }
}
