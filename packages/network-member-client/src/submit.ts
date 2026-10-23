import { verifyRegistrationRequest } from "@coordination-network/user-client"
import type { ChainDomain, RegistrationRequest } from "@coordination-network/user-client"
import { UpdateAction } from "@coordination-network/network-member-proof"
import type { RegistryLocation } from "@coordination-network/network-member-proof"
import type { Address, Hex } from "@coordination-network/identity"
import { NetworkMemberClientError, RegistryRevertError } from "./errors"
import type { IdentityReader, RegistrationProver, RegistrationWriter, SubmitRegistrationResult } from "./types"

export interface SubmitRegistrationPorts {
    domain: ChainDomain
    identityReader: IdentityReader
    prover: RegistrationProver
    writer: RegistrationWriter
}

/** Throws when `port`'s bound registry doesn't match `domain`: a member-app wiring bug, not something a request can trigger. */
function assertRegistryMatches(port: "prover" | "writer", registry: RegistryLocation, domain: RegistryLocation): void {
    if (registry.chainId !== domain.chainId || registry.address.toLowerCase() !== domain.address.toLowerCase()) {
        throw new Error(
            `${port} targets registry ${registry.address} on chain ${registry.chainId}, but domain is ${domain.address} on chain ${domain.chainId}`
        )
    }
}

/** Same guard as `assertRegistryMatches`, for a reader that only reports the address it reads.
 *  Optional on `IdentityReader`, so a no-op when the reader doesn't report one. */
function assertReaderMatches(registryAddress: Address | undefined, domain: RegistryLocation): void {
    if (registryAddress !== undefined && registryAddress.toLowerCase() !== domain.address.toLowerCase()) {
        throw new Error(
            `identityReader targets registry ${registryAddress}, but domain is ${domain.address} on chain ${domain.chainId}`
        )
    }
}

/** Reads the current registry entry, mapping a transport failure to REGISTRY_UNAVAILABLE. */
async function readIdentity(identityReader: IdentityReader, networkId: Hex): Promise<Hex | null> {
    try {
        return await identityReader.getIdentity(networkId)
    } catch (error) {
        throw new NetworkMemberClientError("REGISTRY_UNAVAILABLE", "identity read failed", error)
    }
}

/**
 * Submits a user's signed registration consent to `IdentityRegistry`, as an approved network
 * member. The ports' own registry binding is checked first, then consent, both before any port
 * runs, so a misconfigured member app or a forged/mistargeted request never reaches the registry.
 */
export async function submitRegistration(
    request: RegistrationRequest,
    { domain, identityReader, prover, writer }: SubmitRegistrationPorts
): Promise<SubmitRegistrationResult> {
    const registryDomain: RegistryLocation = { chainId: BigInt(domain.chainId), address: domain.verifyingContract }
    assertRegistryMatches("prover", prover.registry, registryDomain)
    assertRegistryMatches("writer", writer.registry, registryDomain)
    assertReaderMatches(identityReader.registryAddress, registryDomain)

    if (!verifyRegistrationRequest(request, domain)) {
        throw new NetworkMemberClientError("INVALID_REGISTRATION_REQUEST", "registration request failed verification")
    }

    const { networkId, metaStealthAddress } = request

    const existing = await readIdentity(identityReader, networkId)
    if (existing !== null) {
        return {
            status: "alreadyRegistered",
            networkId,
            metaStealthAddress: existing,
            matchesRequest: existing.toLowerCase() === metaStealthAddress.toLowerCase()
        }
    }

    const proof = await prover.prove({ action: UpdateAction.Register, networkId, metaStealthAddress })

    try {
        const write = await writer.registerIdentity(networkId, metaStealthAddress, proof)
        return { status: "submitted", networkId, metaStealthAddress, ...write }
    } catch (error) {
        if (error instanceof RegistryRevertError) {
            // Lost a race between the read above and this write: someone else registered this
            // networkId in between. The re-read, not the revert's own payload, is the source of
            // truth for what the caller should treat as the current entry.
            if (error.errorName === "AlreadyRegistered") {
                let raced: Hex | null
                try {
                    raced = await readIdentity(identityReader, networkId)
                } catch {
                    // The write's revert already confirmed the entry exists; a failed re-read
                    // doesn't change that, so surface the confirmed revert, not the read failure.
                    throw error
                }
                // The registry answered; the write's gas estimate saw pending state the read
                // above did not. The revert is still the right thing to surface.
                if (raced === null) throw error
                return {
                    status: "alreadyRegistered",
                    networkId,
                    metaStealthAddress: raced,
                    matchesRequest: raced.toLowerCase() === metaStealthAddress.toLowerCase()
                }
            }
            throw error
        }
        throw new NetworkMemberClientError("REGISTRY_UNAVAILABLE", "registration submission failed", error)
    }
}
