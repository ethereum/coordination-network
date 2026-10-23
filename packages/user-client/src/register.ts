import { deriveKeys, META_STEALTH_ADDRESS_LENGTH } from "@coordination-network/identity"
import { Hex, Onboarding, RegisterParams, RegisterResult } from "./types"
import { metaStealthAddressFromKeys, displayMetaStealthAddress } from "./meta"
import { buildRegistrationRequest } from "./request"
import { hexToBytes } from "./bytes"
import { RegistryReadFailedError, SubmissionFailedError, UserClientError } from "./errors"

export function onboard(deviceSecret: Uint8Array | Hex): Onboarding {
    const keys = deriveKeys(deviceSecret)
    const metaStealthAddress = metaStealthAddressFromKeys(keys)
    return {
        keys,
        networkId: keys.networkId,
        metaStealthAddress,
        displayMetaStealthAddress: displayMetaStealthAddress(metaStealthAddress)
    }
}

/**
 * IdentityRegistry stores the mapping as `bytes`, so its generated getter answers an unregistered
 * networkId with empty bytes. A reader built straight onto viem or ethers therefore returns "0x"
 * where this package's port requires null, and treating that as an entry would report success while
 * never registering anything.
 */
function readExistingEntry(value: Hex | null, networkId: Hex): Hex | null {
    if (value === null || value === "0x") return null

    const length = hexToBytes(value).length
    if (length !== META_STEALTH_ADDRESS_LENGTH) {
        throw new UserClientError(
            "INVALID_INPUT",
            `RegistryReader returned a ${length}-byte entry for ${networkId}; expected ${META_STEALTH_ADDRESS_LENGTH} bytes or null`
        )
    }
    return value
}

export async function register(params: RegisterParams): Promise<RegisterResult> {
    const { keys, networkId, metaStealthAddress } = onboard(params.deviceSecret)

    let existingRaw: Hex | null
    try {
        existingRaw = await params.registry.getIdentity(networkId)
    } catch (error) {
        throw new RegistryReadFailedError(`registry read failed for ${networkId}`, error)
    }
    const existing = readExistingEntry(existingRaw, networkId)
    if (existing !== null) {
        // A mismatch means this device's keys do not derive the address its networkId currently
        // resolves to. Only a network member calling updateIdentity can change that entry.
        return {
            status: "alreadyRegistered",
            networkId,
            metaStealthAddress: existing,
            derivedMetaStealthAddress: metaStealthAddress,
            matchesDerived: existing.toLowerCase() === metaStealthAddress.toLowerCase()
        }
    }

    const request = buildRegistrationRequest(keys, params.domain)
    let receipt
    try {
        receipt = await params.submitter.submit(request)
    } catch (error) {
        if (error instanceof SubmissionFailedError) throw error
        throw new SubmissionFailedError(`Registration submission failed for ${networkId}`, error)
    }

    return { status: "registered", networkId, metaStealthAddress, request, receipt }
}
