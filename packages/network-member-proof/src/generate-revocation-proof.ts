import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { randomScope } from "./message"
import { proveMessage } from "./prove"
import { revocationMessage } from "./revocation-message"
import { NetworkMemberProof, RegistryLocation, RevocationUpdate } from "./types"

export type GenerateRevocationProofOptions = {
    /** The network member's Semaphore identity. Its commitment must be a leaf of `group`. */
    identity: Identity
    /**
     * The approved-member group, as the Semaphore contract currently holds it. Rebuild it from the
     * group's on-chain membership events: a proof against a root the group no longer holds is only
     * accepted inside the recent-root window.
     */
    group: Group
    /** Where the credential revocation registry is deployed. */
    registry: RegistryLocation
    /** The revocation being authorised. */
    update: RevocationUpdate
    /** The proof's scope. Defaults to a fresh random one, which is what keeps proofs unlinkable. */
    scope?: bigint
}

/**
 * Generates the membership proof that authorises one write to the credential revocation registry.
 *
 * The proof states that some leaf of the approved-member group signed off on this exact revocation,
 * and nothing else: not which leaf, and not who submits it. Submit it from any address, including a
 * fresh stealth address with a paymaster covering the gas, since no write path reads `msg.sender`.
 *
 * One tree holds the whole network's revocations, so nothing about the write names the issuer either.
 */
export async function generateRevocationProof({
    identity,
    group,
    registry,
    update,
    scope = randomScope()
}: GenerateRevocationProofOptions): Promise<NetworkMemberProof> {
    return proveMessage(identity, group, revocationMessage(registry, update), scope)
}
