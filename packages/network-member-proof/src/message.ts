import { bytesToHex, encodeAbiParameters, encodePacked, keccak256 } from "viem"
import { IdentityUpdate, RegistryLocation, UpdateAction } from "./types"

/** Domain string in the registry's `UPDATE_DOMAIN_SEPARATOR`. */
export const UPDATE_MESSAGE_DOMAIN = "coordination-network.identity-registry.update.v1"

/** Empty meta-stealth address, the placeholder a removal binds. */
const NO_META_STEALTH_ADDRESS = "0x" as const

/**
 * The constant half of an update message, mirroring the registry's `UPDATE_DOMAIN_SEPARATOR`. The
 * registry hashes it once at deployment, so a client can also read it from there.
 */
export function updateDomainSeparator(registryAddress: `0x${string}`): `0x${string}` {
    return keccak256(
        encodeAbiParameters([{ type: "string" }, { type: "address" }], [UPDATE_MESSAGE_DOMAIN, registryAddress])
    )
}

/**
 * The Semaphore message binding a proof to one registry update, mirroring the message the registry
 * derives from the arguments it is about to apply: the payload, the registry and the chain.
 *
 * The payload is what stops a proof authorising a different update. The registry address and the
 * chain id place that update at one deployment: a registry does not own its Semaphore group, so two
 * registries can share one, and the same registry can exist at the same address on two chains with
 * the same members and therefore the same root.
 *
 * The registry never accepts a message from the caller, so a proof built for the wrong update does
 * not fail a comparison, it fails verification.
 */
export function updateMessage(registry: RegistryLocation, update: IdentityUpdate): bigint {
    if (update.action === UpdateAction.Remove && update.metaStealthAddress !== undefined) {
        throw new Error("a removal binds no meta-stealth address")
    }

    // Caught here rather than on chain: a proof over the wrong payload costs a full verification to
    // fail, and the proof took real work to produce.
    if (update.action !== UpdateAction.Remove && update.metaStealthAddress === undefined) {
        throw new Error("a registration or update binds a meta-stealth address")
    }

    const metaStealthAddress = update.metaStealthAddress ?? NO_META_STEALTH_ADDRESS

    return BigInt(
        keccak256(
            encodePacked(
                ["bytes32", "uint256", "uint8", "bytes32", "bytes"],
                [
                    updateDomainSeparator(registry.address),
                    registry.chainId,
                    update.action,
                    update.networkId,
                    metaStealthAddress
                ]
            )
        )
    )
}

/**
 * A fresh random scope.
 *
 * A Semaphore nullifier is `poseidon(secret, scope)`, so a random scope gives every proof an
 * unlinkable nullifier: the registry only ever learns that some approved member authorised the
 * update, never that two updates came from the same one. The registry does not constrain the scope;
 * what it relies on is that the nullifier a proof carries can only be spent once.
 */
export function randomScope(): bigint {
    // 31 bytes, so the scope is always a field element. Web Crypto and viem only, so this works
    // in a browser as well as in Node.
    const bytes = new Uint8Array(31)
    crypto.getRandomValues(bytes)

    return BigInt(bytesToHex(bytes))
}
