/**
 * Replays the committed `registration-vectors.json`: a change to key
 * derivation, meta-address encoding, or the EIP-712 digest must fail here,
 * forcing deliberate vector regeneration.
 */

import { describe, it, expect } from "@jest/globals"
import { deriveKeys, META_STEALTH_ADDRESS_LENGTH, META_STEALTH_URI_PREFIX } from "@coordination-network/identity"
import { metaStealthAddressFromKeys, displayMetaStealthAddress } from "../src/meta"
import { identityRegistryDomainSeparator, registerIdentityStructHash, registerIdentityDigest } from "../src/eip712"
import { signRegisterIdentity, verifyRegistrationRequest } from "../src/request"
import {
    SCHEME_ID,
    IDENTITY_REGISTRY_DOMAIN_NAME,
    IDENTITY_REGISTRY_DOMAIN_VERSION,
    REGISTER_IDENTITY_TYPE,
    EIP712_DOMAIN_TYPE
} from "../src/constants"
import type { ChainDomain, Hex, RegistrationRequest } from "../src/types"
import vectorsDocument from "./vectors/registration-vectors.json"

interface Vector {
    deviceSecret: Hex
    networkId: Hex
    metaStealthAddress: Hex
    displayMetaStealthAddress: string
    domainSeparator: Hex
    structHash: Hex
    digest: Hex
    signature: Hex
}

const { scheme, vectors } = vectorsDocument as unknown as {
    scheme: {
        domain: ChainDomain
        schemeId: number
        metaStealthAddressLength: number
        identityRegistryDomainName: string
        identityRegistryDomainVersion: string
        registerIdentityType: string
        eip712DomainType: string
        stealthMetaAddressPrefix: string
        algorithm: string
    }
    vectors: Vector[]
}

describe("committed registration vectors — header", () => {
    it("echoes the current normative scheme constants", () => {
        expect(scheme.domain).toEqual({ chainId: 31337, verifyingContract: `0x${"04".repeat(19)}e7` })
        expect(scheme.schemeId).toBe(SCHEME_ID)
        expect(scheme.metaStealthAddressLength).toBe(META_STEALTH_ADDRESS_LENGTH)
        expect(scheme.identityRegistryDomainName).toBe(IDENTITY_REGISTRY_DOMAIN_NAME)
        expect(scheme.identityRegistryDomainVersion).toBe(IDENTITY_REGISTRY_DOMAIN_VERSION)
        expect(scheme.registerIdentityType).toBe(REGISTER_IDENTITY_TYPE)
        expect(scheme.eip712DomainType).toBe(EIP712_DOMAIN_TYPE)
        expect(scheme.stealthMetaAddressPrefix).toBe(META_STEALTH_URI_PREFIX)
        expect(scheme.algorithm).toBe(
            "ERC-6538 scheme 1 meta-address + EIP-712 RegisterIdentity consent digest, domain-bound to the IdentityRegistry deployment"
        )
    })

    it("contains a non-trivial number of vectors", () => {
        expect(vectors.length).toBeGreaterThanOrEqual(5)
        // Both recovery ids must appear, or a wrong v = 27 + recovery would go unnoticed.
        expect(new Set(vectors.map((vector) => parseInt(vector.signature.slice(-2), 16)))).toEqual(new Set([27, 28]))
    })
})

describe("committed registration vectors — replay", () => {
    it.each(vectors.map((vector) => [vector.deviceSecret, vector] as const))(
        "reproduces every field for %s",
        (_deviceSecret, vector) => {
            const keys = deriveKeys(vector.deviceSecret)
            const metaStealthAddress = metaStealthAddressFromKeys(keys)
            const domainSeparator = identityRegistryDomainSeparator(scheme.domain)
            const structHash = registerIdentityStructHash(keys.networkId, metaStealthAddress)
            const digest = registerIdentityDigest(scheme.domain, keys.networkId, metaStealthAddress)
            const signature = signRegisterIdentity(keys.account.privateKey, digest)

            expect(keys.networkId).toBe(vector.networkId)
            expect(metaStealthAddress).toBe(vector.metaStealthAddress)
            expect(displayMetaStealthAddress(metaStealthAddress)).toBe(vector.displayMetaStealthAddress)
            expect(domainSeparator).toBe(vector.domainSeparator)
            expect(structHash).toBe(vector.structHash)
            expect(digest).toBe(vector.digest)
            expect(signature).toBe(vector.signature)
        }
    )

    it.each(vectors.map((vector) => [vector.deviceSecret, vector] as const))(
        "verifies as a valid registration request for %s",
        (_deviceSecret, vector) => {
            const request: RegistrationRequest = {
                version: "v1",
                networkId: vector.networkId,
                schemeId: 1,
                metaStealthAddress: vector.metaStealthAddress,
                chainId: scheme.domain.chainId,
                verifyingContract: scheme.domain.verifyingContract,
                signature: vector.signature
            }

            expect(verifyRegistrationRequest(request, scheme.domain)).toBe(true)
        }
    )
})
