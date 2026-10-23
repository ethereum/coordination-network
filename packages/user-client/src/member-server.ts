import { keccak_256 } from "@noble/hashes/sha3"
import { ChainDomain, RegistrationRequest, RegistrationSubmitter, SubmissionReceipt } from "./types"
import { hexToBytes, bytesToHex } from "./bytes"
import { verifyRegistrationRequest } from "./request"
import { SubmissionFailedError } from "./errors"
import { InMemoryIdentityRegistry } from "./registry"

/**
 * Stands in for an approved network member's server: checks the user's consent the way a real
 * server must before writing, then writes. The Semaphore proof a real server builds before
 * submitting on chain is implied by construction, not modeled here.
 */
export class InMemoryMemberServer implements RegistrationSubmitter {
    constructor(
        private readonly registry: InMemoryIdentityRegistry,
        private readonly domain: ChainDomain
    ) {}

    async submit(request: RegistrationRequest): Promise<SubmissionReceipt> {
        if (!verifyRegistrationRequest(request, this.domain)) {
            throw new SubmissionFailedError("InvalidRegistrationRequest")
        }
        this.registry.registerIdentity(request.networkId, request.metaStealthAddress)
        return { txHash: bytesToHex(keccak_256(hexToBytes(request.signature))) }
    }
}
