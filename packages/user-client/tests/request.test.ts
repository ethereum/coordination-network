import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"
import { computeMemberNetworkId, deriveKeys } from "@coordination-network/identity"
import { signRegisterIdentity, buildRegistrationRequest, verifyRegistrationRequest } from "../src/request"
import { registerIdentityDigest } from "../src/eip712"
import { hexToBytes, bytesToHex, concatBytes } from "../src/bytes"
import { ChainDomain, Hex, RegistrationRequest } from "../src/types"
import { UserClientError } from "../src/errors"

const DEVICE_SECRET: Hex = `0x${"33".repeat(32)}`
const DOMAIN: ChainDomain = {
    chainId: 31337,
    verifyingContract: `0x${"04".repeat(19)}e7`
}
const OTHER_DOMAIN: ChainDomain = {
    chainId: 1,
    verifyingContract: `0x${"05".repeat(19)}e7`
}

function flipOneHexChar(hex: Hex): Hex {
    const body = hex.slice(2)
    const index = 2
    const current = body[index]
    const flipped = current === "0" ? "1" : "0"
    return `0x${body.slice(0, index)}${flipped}${body.slice(index + 1)}` as Hex
}

describe("signRegisterIdentity", () => {
    it("returns a 65-byte r||s||v signature with v = 27 or 28", () => {
        const keys = deriveKeys(DEVICE_SECRET)
        const digest = registerIdentityDigest(DOMAIN, keys.networkId, keys.networkId)
        const signature = signRegisterIdentity(keys.account.privateKey, digest)
        const bytes = hexToBytes(signature)

        expect(bytes).toHaveLength(65)
        expect([27, 28]).toContain(bytes[64])
    })

    it("refuses to sign anything that is not a 32-byte digest", () => {
        // Exported, so it must not become a blind-signing oracle for the account key.
        expect(() => signRegisterIdentity(keys.account.privateKey, `0x${"11".repeat(31)}`)).toThrow(UserClientError)
    })
})

const keys = deriveKeys(DEVICE_SECRET)

/** Builds a request self-consistently signed over whatever widths it is given. */
function signedOver(networkId: Hex, metaStealthAddress: Hex): RegistrationRequest {
    const digest = registerIdentityDigest(DOMAIN, networkId, metaStealthAddress)
    return {
        version: "v1",
        networkId,
        schemeId: 1,
        metaStealthAddress,
        chainId: DOMAIN.chainId,
        verifyingContract: DOMAIN.verifyingContract,
        signature: signRegisterIdentity(keys.account.privateKey, digest)
    }
}

describe("buildRegistrationRequest + verifyRegistrationRequest", () => {
    const request = buildRegistrationRequest(keys, DOMAIN)

    it("produces a request that verifies", () => {
        expect(verifyRegistrationRequest(request, DOMAIN)).toBe(true)
    })

    it("rejects a flipped networkId", () => {
        const mutated: RegistrationRequest = { ...request, networkId: flipOneHexChar(request.networkId) }
        expect(verifyRegistrationRequest(mutated, DOMAIN)).toBe(false)
    })

    it("rejects a flipped metaStealthAddress", () => {
        const mutated: RegistrationRequest = {
            ...request,
            metaStealthAddress: flipOneHexChar(request.metaStealthAddress)
        }
        expect(verifyRegistrationRequest(mutated, DOMAIN)).toBe(false)
    })

    it("rejects a different chainId", () => {
        const mutated: RegistrationRequest = { ...request, chainId: request.chainId + 1 }
        expect(verifyRegistrationRequest(mutated, DOMAIN)).toBe(false)
    })

    it("rejects a different verifyingContract", () => {
        const mutated: RegistrationRequest = {
            ...request,
            verifyingContract: `0x${"05".repeat(19)}e7`
        }
        expect(verifyRegistrationRequest(mutated, DOMAIN)).toBe(false)
    })

    it("rejects a flipped signature", () => {
        const mutated: RegistrationRequest = { ...request, signature: flipOneHexChar(request.signature) }
        expect(verifyRegistrationRequest(mutated, DOMAIN)).toBe(false)
    })

    it.each([0, 26, 29, 0x44])("rejects a recovery byte of %i that is neither 27 nor 28", (v) => {
        const signatureBytes = hexToBytes(request.signature)
        signatureBytes[64] = v
        const mutated: RegistrationRequest = { ...request, signature: bytesToHex(signatureBytes) }

        expect(verifyRegistrationRequest(mutated, DOMAIN)).toBe(false)
    })

    it("rejects a request signed with the spending key instead of the account key", () => {
        const digest = registerIdentityDigest(DOMAIN, keys.networkId, request.metaStealthAddress)
        const wrongSignature = signRegisterIdentity(keys.spending.privateKey, digest)
        const wrongKeyRequest: RegistrationRequest = { ...request, signature: wrongSignature }

        expect(verifyRegistrationRequest(wrongKeyRequest, DOMAIN)).toBe(false)
    })

    it("rejects the malleable high-S twin of a valid signature (matches OZ ECDSA.recover's EIP-2 guard)", () => {
        const signatureBytes = hexToBytes(request.signature)
        const r = signatureBytes.slice(0, 32)
        const s = BigInt(bytesToHex(signatureBytes.slice(32, 64)))
        const v = signatureBytes[64]
        const recovery = v - 27

        const highS = secp256k1.CURVE.n - s
        const highSBytes = hexToBytes(`0x${highS.toString(16).padStart(64, "0")}` as Hex)
        const flippedRecovery = recovery === 0 ? 1 : 0
        const malleableSignature = bytesToHex(concatBytes(r, highSBytes, Uint8Array.from([27 + flippedRecovery])))

        // Sanity: the twin must recover to the same key as the original, or this would pass for the
        // wrong reason — a garbled signature rather than the malleability guard.
        expect(highS).toBeGreaterThan(secp256k1.CURVE.n / 2n)
        const digest = registerIdentityDigest(DOMAIN, request.networkId, request.metaStealthAddress)
        const twinKey = secp256k1.Signature.fromCompact(concatBytes(r, highSBytes))
            .addRecoveryBit(flippedRecovery)
            .recoverPublicKey(hexToBytes(digest))
            .toHex(true)
        expect(twinKey).toBe(keys.account.publicKey.slice(2))

        const malleableRequest: RegistrationRequest = { ...request, signature: malleableSignature }
        expect(verifyRegistrationRequest(malleableRequest, DOMAIN)).toBe(false)
    })

    it("rejects a request whose domain is not the caller's own registry", () => {
        const otherChain: ChainDomain = { ...DOMAIN, chainId: DOMAIN.chainId + 1 }
        const otherContract: ChainDomain = { ...DOMAIN, verifyingContract: `0x${"07".repeat(20)}` }

        // Each request is internally consistent; only the expected domain differs.
        expect(verifyRegistrationRequest(buildRegistrationRequest(keys, otherChain), DOMAIN)).toBe(false)
        expect(verifyRegistrationRequest(buildRegistrationRequest(keys, otherContract), DOMAIN)).toBe(false)
    })

    it("rejects a request whose envelope matches expected but was signed over a different domain's digest", () => {
        // Unlike the case above, chainId/verifyingContract are patched to equal DOMAIN's, so the
        // envelope-equality check alone cannot reject this — only recomputing the digest from
        // `expected` (not the request's own, now-matching fields) does.
        const request = buildRegistrationRequest(keys, OTHER_DOMAIN)
        const patched: RegistrationRequest = {
            ...request,
            chainId: DOMAIN.chainId,
            verifyingContract: DOMAIN.verifyingContract
        }

        expect(verifyRegistrationRequest(patched, DOMAIN)).toBe(false)
    })

    it("refuses to sign a networkId that is not a bytes32 word", () => {
        const shortNetworkId = `0x${"00".repeat(11)}${keys.networkId.slice(-40)}` as Hex

        expect(() => registerIdentityDigest(DOMAIN, shortNetworkId, request.metaStealthAddress)).toThrow(
            UserClientError
        )
    })

    it("rejects widths the contract's ABI cannot accept", () => {
        const shortMeta = `0x${"ab".repeat(10)}` as Hex
        // Signed consistently over a 10-byte meta-address: self-consistent, but unsubmittable.
        expect(verifyRegistrationRequest(signedOver(keys.networkId, shortMeta), DOMAIN)).toBe(false)

        // A hand-forged 31-byte networkId cannot come from this package's signer, so build it raw.
        const shortNetworkId = `0x${"00".repeat(11)}${keys.networkId.slice(-40)}` as Hex
        expect(verifyRegistrationRequest({ ...request, networkId: shortNetworkId }, DOMAIN)).toBe(false)
    })

    it("rejects a 66-byte meta-stealth address that is not two on-curve compressed keys", () => {
        // Right width, wrong content: neither half decodes to a point on the curve.
        const allZero = `0x${"00".repeat(66)}` as Hex
        expect(verifyRegistrationRequest(signedOver(keys.networkId, allZero), DOMAIN)).toBe(false)

        const offCurveHalves = `0x02${"ff".repeat(32)}02${"ff".repeat(32)}` as Hex
        expect(verifyRegistrationRequest(signedOver(keys.networkId, offCurveHalves), DOMAIN)).toBe(false)
    })

    it("rejects a networkId whose upper 12 bytes are not the recovered key's", () => {
        // The contract compares only the low 20 bytes, so this would otherwise let one key claim
        // 2^96 distinct identities.
        const forged = `0x${"de".repeat(12)}${keys.networkId.slice(-40)}` as Hex

        expect(verifyRegistrationRequest(signedOver(forged, request.metaStealthAddress), DOMAIN)).toBe(false)
    })

    it("refuses the address-carrying plain-hash id and accepts the v2 id for the same key", () => {
        const plainHashId = computeMemberNetworkId(keys.account.uncompressedPublicKey)

        expect(plainHashId).not.toBe(keys.networkId)
        expect(verifyRegistrationRequest(signedOver(plainHashId, request.metaStealthAddress), DOMAIN)).toBe(false)
        expect(verifyRegistrationRequest(signedOver(keys.networkId, request.metaStealthAddress), DOMAIN)).toBe(true)
    })

    it("rejects unsigned envelope fields rather than trusting them", () => {
        expect(verifyRegistrationRequest({ ...request, schemeId: 999 as never }, DOMAIN)).toBe(false)
        expect(verifyRegistrationRequest({ ...request, version: "v99" as never }, DOMAIN)).toBe(false)
    })

    it("returns false instead of throwing on malformed untrusted input", () => {
        const malformed: Array<Partial<RegistrationRequest>> = [
            { networkId: "0xzz" as Hex },
            { metaStealthAddress: "not-hex" as Hex },
            { signature: "0x" as Hex },
            { chainId: -1 },
            { chainId: 1.5 },
            { chainId: "31337" as never },
            { verifyingContract: "0x1234" as Hex },
            { networkId: undefined as never }
        ]

        for (const patch of malformed) {
            expect(verifyRegistrationRequest({ ...request, ...patch }, DOMAIN)).toBe(false)
        }
    })
})
