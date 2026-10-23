import { secp256k1 } from "@noble/curves/secp256k1"
import {
    computeNetworkId,
    DerivedKeys,
    META_STEALTH_ADDRESS_LENGTH,
    validateMetaStealthAddress
} from "@coordination-network/identity"
import { ChainDomain, Hex, RegistrationRequest } from "./types"
import { hexToBytes, bytesToHex, concatBytes } from "./bytes"
import { UserClientError } from "./errors"
import { registerIdentityDigest } from "./eip712"
import { metaStealthAddressFromKeys } from "./meta"
import { DIGEST_LENGTH, NETWORK_ID_LENGTH, REQUEST_VERSION, SCHEME_ID, SIGNATURE_LENGTH } from "./constants"

/** Returns a 65-byte `r || s || v` signature, with `v = 27 + recovery id` as the contract expects. */
export function signRegisterIdentity(accountPrivateKey: Hex, digest: Hex): Hex {
    const digestBytes = hexToBytes(digest)
    if (digestBytes.length !== DIGEST_LENGTH) {
        // Exported, so refuse to sign anything that is not a digest this package produced.
        throw new UserClientError("INVALID_INPUT", `Expected a ${DIGEST_LENGTH}-byte digest, got ${digestBytes.length}`)
    }
    const signature = secp256k1.sign(digestBytes, hexToBytes(accountPrivateKey), { lowS: true })
    return bytesToHex(concatBytes(signature.toCompactRawBytes(), Uint8Array.from([27 + signature.recovery])))
}

export function buildRegistrationRequest(keys: DerivedKeys, domain: ChainDomain): RegistrationRequest {
    const metaStealthAddress = metaStealthAddressFromKeys(keys)
    const digest = registerIdentityDigest(domain, keys.networkId, metaStealthAddress)
    return {
        version: REQUEST_VERSION,
        networkId: keys.networkId,
        schemeId: SCHEME_ID,
        metaStealthAddress,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
        signature: signRegisterIdentity(keys.account.privateKey, digest)
    }
}

/**
 * Whether a member server pinned to `expected` should accept the request: field widths, a
 * well-formed meta-stealth address, the domain, and a signer matching the full `networkId`.
 *
 * `expected` is required because the domain inside a request is attacker-controlled — verifying
 * against it would only prove the request is self-consistent, not that it targets this registry.
 *
 * Returns false rather than throwing, so an untrusted request can be passed in as-is.
 */
export function verifyRegistrationRequest(request: RegistrationRequest, expected: ChainDomain): boolean {
    try {
        if (request.version !== REQUEST_VERSION || request.schemeId !== SCHEME_ID) return false

        // Neither field is covered by the signature, so both have to be pinned to the caller's own
        // registry. Otherwise a signature made for another chain or contract replays here.
        if (request.chainId !== expected.chainId) return false
        if (request.verifyingContract.toLowerCase() !== expected.verifyingContract.toLowerCase()) return false

        // The contract types these as bytes32 and a 66-byte bytes. A request signed self-consistently
        // over the wrong width verifies against itself but cannot be submitted.
        const networkIdBytes = hexToBytes(request.networkId)
        if (networkIdBytes.length !== NETWORK_ID_LENGTH) return false
        if (hexToBytes(request.metaStealthAddress).length !== META_STEALTH_ADDRESS_LENGTH) return false

        // Width alone admits 66 bytes the contract would store but no one could ever pay to.
        if (!validateMetaStealthAddress(request.metaStealthAddress)) return false

        const signatureBytes = hexToBytes(request.signature)
        if (signatureBytes.length !== SIGNATURE_LENGTH) return false

        const rs = signatureBytes.slice(0, 64)
        const recovery = signatureBytes[64] - 27
        if (recovery !== 0 && recovery !== 1) return false

        const digest = registerIdentityDigest(expected, request.networkId, request.metaStealthAddress)
        const signature = secp256k1.Signature.fromCompact(rs).addRecoveryBit(recovery)

        // Signing uses `lowS` (EIP-2), so verification rejects high-S to agree with it.
        if (signature.hasHighS()) return false

        const recoveredPublicKey = signature.recoverPublicKey(hexToBytes(digest)).toBytes(false)

        // Compare all 32 bytes of the hash. A partial match would leave bytes unauthenticated and let
        // one key claim many ids. The contract itself checks no signer at all.
        return computeNetworkId(recoveredPublicKey).toLowerCase() === request.networkId.toLowerCase()
    } catch {
        return false
    }
}
