import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { randomScope, updateMessage } from "./message"
import { proveMessage } from "./prove"
import { IdentityUpdate, NetworkMemberProof, RegistryLocation } from "./types"

export type GenerateSemaphoreProofOptions = {
    /** The network member's Semaphore identity. Its commitment must be a leaf of `group`. */
    identity: Identity
    /**
     * The approved-member group, as the registry's Semaphore group currently holds it. Rebuild it
     * from the group's on-chain membership events: a proof against a root the group no longer holds
     * is only accepted inside Semaphore's recent-root window.
     */
    group: Group
    /** Where the registry is deployed. */
    registry: RegistryLocation
    /** The update being authorised. */
    update: IdentityUpdate
    /** The proof's scope. Defaults to a fresh random one, which is what keeps proofs unlinkable. */
    scope?: bigint
}

/**
 * Generates the membership proof that authorises one registry update.
 *
 * The proof states that some leaf of the approved-member group signed off on this exact update, and
 * nothing else: not which leaf, and not who submits it. Submit it from any address, since no write
 * path reads `msg.sender`.
 *
 * `identity` and `group` are Semaphore's own types, taken as given here. Creating a member identity
 * and maintaining the group are governance and onboarding concerns, not proof generation.
 *
 * The message binds the proof to this update at this registry on this chain, so it cannot be
 * replayed against another payload, and Semaphore burns the nullifier on the way in, so the proof
 * itself cannot be submitted twice.
 */
export async function generateSemaphoreProof({
    identity,
    group,
    registry,
    update,
    scope = randomScope()
}: GenerateSemaphoreProofOptions): Promise<NetworkMemberProof> {
    return proveMessage(identity, group, updateMessage(registry, update), scope)
}
