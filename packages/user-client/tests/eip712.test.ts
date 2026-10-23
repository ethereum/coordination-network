import { describe, it, expect } from "@jest/globals"
import { keccak_256 } from "@noble/hashes/sha3"
import { concatBytes } from "@noble/hashes/utils"
import { domainSeparator, hashTypedData } from "viem"
import { identityRegistryDomainSeparator, registerIdentityStructHash, registerIdentityDigest } from "../src/eip712"
import { hexToBytes, bytesToHex } from "../src/bytes"
import { ChainDomain, Hex } from "../src/types"
import { IDENTITY_REGISTRY_DOMAIN_NAME, IDENTITY_REGISTRY_DOMAIN_VERSION, SCHEME_ID } from "../src/constants"
import vectorsDocument from "./vectors/registration-vectors.json"

const DOMAIN: ChainDomain = {
    chainId: 1,
    verifyingContract: `0x${"00".repeat(19)}aa`
}

const NETWORK_ID: Hex = `0x${"11".repeat(32)}`
const META_A: Hex = `0x${"aa".repeat(66)}`
const META_B: Hex = `0x${"ab"}${"aa".repeat(65)}`

const { scheme, vectors } = vectorsDocument as unknown as {
    scheme: { domain: ChainDomain }
    vectors: { networkId: Hex; metaStealthAddress: Hex }[]
}

describe("identityRegistryDomainSeparator", () => {
    it("is deterministic for identical inputs", () => {
        expect(identityRegistryDomainSeparator(DOMAIN)).toEqual(identityRegistryDomainSeparator(DOMAIN))
    })

    it("changes when chainId changes", () => {
        const other: ChainDomain = { ...DOMAIN, chainId: 2 }
        expect(identityRegistryDomainSeparator(DOMAIN)).not.toEqual(identityRegistryDomainSeparator(other))
    })

    it("changes when verifyingContract changes", () => {
        const other: ChainDomain = {
            ...DOMAIN,
            verifyingContract: `0x${"00".repeat(19)}bb`
        }
        expect(identityRegistryDomainSeparator(DOMAIN)).not.toEqual(identityRegistryDomainSeparator(other))
    })
})

describe("registerIdentityStructHash", () => {
    it("is deterministic for identical inputs", () => {
        expect(registerIdentityStructHash(NETWORK_ID, META_A)).toEqual(registerIdentityStructHash(NETWORK_ID, META_A))
    })

    it("changes when networkId changes", () => {
        const otherNetworkId: Hex = `0x${"22".repeat(32)}`
        expect(registerIdentityStructHash(NETWORK_ID, META_A)).not.toEqual(
            registerIdentityStructHash(otherNetworkId, META_A)
        )
    })

    it("changes when metaStealthAddress changes by a single byte (hashes the bytes, not raw)", () => {
        expect(registerIdentityStructHash(NETWORK_ID, META_A)).not.toEqual(
            registerIdentityStructHash(NETWORK_ID, META_B)
        )
    })
})

describe("registerIdentityDigest", () => {
    it("is deterministic for identical inputs", () => {
        expect(registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)).toEqual(
            registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)
        )
    })

    it("changes when chainId changes", () => {
        const other: ChainDomain = { ...DOMAIN, chainId: 2 }
        expect(registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)).not.toEqual(
            registerIdentityDigest(other, NETWORK_ID, META_A)
        )
    })

    it("changes when verifyingContract changes", () => {
        const other: ChainDomain = {
            ...DOMAIN,
            verifyingContract: `0x${"00".repeat(19)}bb`
        }
        expect(registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)).not.toEqual(
            registerIdentityDigest(other, NETWORK_ID, META_A)
        )
    })

    it("changes when networkId changes", () => {
        const otherNetworkId: Hex = `0x${"22".repeat(32)}`
        expect(registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)).not.toEqual(
            registerIdentityDigest(DOMAIN, otherNetworkId, META_A)
        )
    })

    it("changes when metaStealthAddress changes", () => {
        expect(registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)).not.toEqual(
            registerIdentityDigest(DOMAIN, NETWORK_ID, META_B)
        )
    })

    it("is 32 bytes (66 hex chars incl. 0x)", () => {
        const digest = registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)
        expect(digest).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it("differs from the struct hash and the domain separator", () => {
        const digest = registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)
        expect(digest).not.toEqual(registerIdentityStructHash(NETWORK_ID, META_A))
        expect(digest).not.toEqual(identityRegistryDomainSeparator(DOMAIN))
    })

    it("actually depends on the 0x1901 prefix (naive hash without it differs)", () => {
        const domainSeparator = hexToBytes(identityRegistryDomainSeparator(DOMAIN))
        const structHash = hexToBytes(registerIdentityStructHash(NETWORK_ID, META_A))
        const naive = keccak_256(concatBytes(domainSeparator, structHash))
        expect(registerIdentityDigest(DOMAIN, NETWORK_ID, META_A)).not.toEqual(bytesToHex(naive))
    })
})

// Pinned to viem's own EIP-712 implementation, independent of ours, so the hand-rolled encoding
// in eip712.ts cannot drift from what a standard signer computes.
describe("digest matches an independent viem implementation", () => {
    const viemDomain = {
        name: IDENTITY_REGISTRY_DOMAIN_NAME,
        version: IDENTITY_REGISTRY_DOMAIN_VERSION,
        chainId: scheme.domain.chainId,
        verifyingContract: scheme.domain.verifyingContract
    }

    it("matches viem's domainSeparator", () => {
        expect(identityRegistryDomainSeparator(scheme.domain).toLowerCase()).toBe(
            domainSeparator({ domain: viemDomain }).toLowerCase()
        )
    })

    it.each(vectors.slice(0, 2))("matches viem's hashTypedData for $networkId", (vector) => {
        const expectedDigest = hashTypedData({
            domain: viemDomain,
            types: {
                RegisterIdentity: [
                    { name: "networkId", type: "bytes32" },
                    { name: "schemeId", type: "uint256" },
                    { name: "metaStealthAddress", type: "bytes" }
                ]
            },
            primaryType: "RegisterIdentity",
            message: {
                networkId: vector.networkId,
                schemeId: BigInt(SCHEME_ID),
                metaStealthAddress: vector.metaStealthAddress
            }
        })
        expect(registerIdentityDigest(scheme.domain, vector.networkId, vector.metaStealthAddress).toLowerCase()).toBe(
            expectedDigest.toLowerCase()
        )
    })
})
