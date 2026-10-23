import { META_STEALTH_ADDRESS_LENGTH } from "@coordination-network/identity"
import { Hex, RegistryReader } from "./types"
import { hexToBytes } from "./bytes"
import { SubmissionFailedError } from "./errors"

/**
 * In-memory stand-in for the registry's read model and the two reverts on its register path,
 * length then duplicate; updateIdentity/removeIdentity are not modelled. `tests/integration`
 * asserts both reverts against the real contract and this fake side by side.
 */
export class InMemoryIdentityRegistry implements RegistryReader {
    private readonly identities = new Map<Hex, Hex>()

    registerIdentity(networkId: Hex, metaStealthAddress: Hex): void {
        const length = hexToBytes(metaStealthAddress).length
        if (length !== META_STEALTH_ADDRESS_LENGTH) {
            throw new SubmissionFailedError(
                `InvalidMetaStealthAddressLength: expected ${META_STEALTH_ADDRESS_LENGTH} bytes, got ${length}`
            )
        }

        const key = networkId.toLowerCase() as Hex
        if (this.identities.has(key)) {
            throw new SubmissionFailedError(`AlreadyRegistered: ${networkId}`)
        }
        this.identities.set(key, metaStealthAddress)
    }

    async getIdentity(networkId: Hex): Promise<Hex | null> {
        return this.identities.get(networkId.toLowerCase() as Hex) ?? null
    }
}
