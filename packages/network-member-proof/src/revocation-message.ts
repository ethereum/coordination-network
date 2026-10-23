import { encodeAbiParameters, encodePacked, keccak256 } from "viem"
import { RegistryLocation, RevocationAction, RevocationUpdate } from "./types"

/** Domain string in the registry's `REVOCATION_DOMAIN_SEPARATOR`. */
export const REVOCATION_MESSAGE_DOMAIN = "coordination-network.credential-revocation-registry.revocation.v1"

/**
 * The constant half of a revocation message, mirroring the registry's `REVOCATION_DOMAIN_SEPARATOR`.
 * The registry hashes it once at deployment, so a client can read it from there instead.
 */
export function revocationDomainSeparator(registryAddress: `0x${string}`): `0x${string}` {
    return keccak256(
        encodeAbiParameters([{ type: "string" }, { type: "address" }], [REVOCATION_MESSAGE_DOMAIN, registryAddress])
    )
}

/**
 * The message binding a proof to one mutation of the credential revocation registry: the action and
 * the commitments, at that registry on that chain. It mirrors what the registry derives from the
 * arguments it applies, so a proof aimed elsewhere fails verification.
 *
 * Predecessor indices are absent here as they are on chain. An index is a witness the LeanIMT+
 * validates, not a privilege, so leaving it unbound lets a member who lost a race recompute it and
 * resubmit the same proof; a revert does not burn the nullifier.
 *
 * `RevokeMany` is a distinct action because a one-commitment batch would otherwise pack identically
 * to a single revocation.
 */
export function revocationMessage(registry: RegistryLocation, update: RevocationUpdate): bigint {
    switch (update.action) {
        case RevocationAction.Revoke:
        case RevocationAction.Unrevoke:
            return BigInt(
                keccak256(
                    encodePacked(
                        ["bytes32", "uint256", "uint8", "uint256"],
                        [
                            revocationDomainSeparator(registry.address),
                            registry.chainId,
                            update.action,
                            update.revocationCommitment
                        ]
                    )
                )
            )
        case RevocationAction.RevokeMany:
            if (update.revocationCommitments.length === 0) {
                throw new Error("a batch binds at least one commitment")
            }

            return BigInt(
                keccak256(
                    encodePacked(
                        ["bytes32", "uint256", "uint8", "uint256[]"],
                        [
                            revocationDomainSeparator(registry.address),
                            registry.chainId,
                            update.action,
                            [...update.revocationCommitments]
                        ]
                    )
                )
            )
        case RevocationAction.UpdateCommitment:
            return BigInt(
                keccak256(
                    encodePacked(
                        ["bytes32", "uint256", "uint8", "uint256", "uint256"],
                        [
                            revocationDomainSeparator(registry.address),
                            registry.chainId,
                            update.action,
                            update.oldRevocationCommitment,
                            update.newRevocationCommitment
                        ]
                    )
                )
            )
        default:
            throw new Error("unknown revocation action")
    }
}
