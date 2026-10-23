import { Identity } from "@semaphore-protocol/identity"
import { bytesToHex, randomBytes } from "@noble/hashes/utils"
import {
    deriveRevocationCommitment,
    generateRevocationSecret,
    signCommitmentOwnership,
    verifyCommitmentOwnership
} from "@coordination-network/credential"
import { SNARK_SCALAR_FIELD } from "@coordination-network/issuer-set"
import { lowOrderRevocation, mixedOrderRevocation } from "./fixtures"

const nonce = randomBytes(32)

describe("revocation secret and commitment", () => {
    it("generates 32 fresh bytes each time", () => {
        const a = generateRevocationSecret()
        const b = generateRevocationSecret()
        expect(a).toHaveLength(32)
        expect(b).toHaveLength(32)
        expect(bytesToHex(a)).not.toBe(bytesToHex(b))
    })

    it("derives commitment = new Identity(r).commitment, deterministically", () => {
        const r = generateRevocationSecret()
        expect(deriveRevocationCommitment(r)).toBe(new Identity(r).commitment)
        expect(deriveRevocationCommitment(r)).toBe(deriveRevocationCommitment(r))
        expect(deriveRevocationCommitment(generateRevocationSecret())).not.toBe(deriveRevocationCommitment(r))
    })

    it("regression: hex-string r derives a different key than the raw bytes", () => {
        const r = generateRevocationSecret()
        expect(new Identity(bytesToHex(r)).commitment).not.toBe(deriveRevocationCommitment(r))
    })

    it("rejects a secret that is not 32 bytes", () => {
        expect(() => deriveRevocationCommitment(new Uint8Array(31))).toThrow()
        expect(() => signCommitmentOwnership(new Uint8Array(33), nonce)).toThrow()
    })
})

describe("commitment ownership", () => {
    const r = generateRevocationSecret()
    const commitment = deriveRevocationCommitment(r)
    const ownership = signCommitmentOwnership(r, nonce)

    it("round-trips: the issuer recomputes the commitment and accepts", () => {
        expect(
            verifyCommitmentOwnership({
                commitment,
                publicKey: ownership.publicKey,
                signature: ownership.signature,
                nonce
            })
        ).toBe(true)
    })

    it("rejects a different nonce (replay)", () => {
        expect(
            verifyCommitmentOwnership({
                commitment,
                publicKey: ownership.publicKey,
                signature: ownership.signature,
                nonce: randomBytes(32)
            })
        ).toBe(false)
    })

    it("rejects a smuggled commitment that does not match the public key", () => {
        expect(
            verifyCommitmentOwnership({
                commitment: commitment + 1n,
                publicKey: ownership.publicKey,
                signature: ownership.signature,
                nonce
            })
        ).toBe(false)
    })

    it("rejects a signature from a different identity over the same nonce", () => {
        const other = signCommitmentOwnership(generateRevocationSecret(), nonce)
        expect(
            verifyCommitmentOwnership({
                commitment,
                publicKey: ownership.publicKey,
                signature: other.signature,
                nonce
            })
        ).toBe(false)
    })

    it("returns false instead of throwing on garbage inputs", () => {
        expect(
            verifyCommitmentOwnership({
                commitment,
                publicKey: [1n, 2n],
                signature: ownership.signature,
                nonce
            })
        ).toBe(false)
        expect(
            verifyCommitmentOwnership({
                commitment,
                publicKey: ownership.publicKey,
                signature: ownership.signature,
                nonce: new Uint8Array(0)
            })
        ).toBe(false)
    })

    it("rejects a low-order key whose signature needs no secret", () => {
        const forged = lowOrderRevocation()

        expect(
            verifyCommitmentOwnership({
                commitment: forged.commitment,
                publicKey: forged.publicKey,
                signature: forged.ownershipSignature,
                nonce
            })
        ).toBe(false)
    })

    it("rejects a mixed-order key with a signature that verifies under it", () => {
        const variant = mixedOrderRevocation(r, nonce)

        expect(
            verifyCommitmentOwnership({
                commitment: variant.commitment,
                publicKey: variant.publicKey,
                signature: variant.ownershipSignature,
                nonce
            })
        ).toBe(false)
    })

    it.each([
        ["above the field", SNARK_SCALAR_FIELD],
        ["negative", -SNARK_SCALAR_FIELD]
    ])("rejects a coordinate %s", (_, offset) => {
        const [x, y] = ownership.publicKey

        expect(
            verifyCommitmentOwnership({
                commitment,
                publicKey: [x + offset, y],
                signature: ownership.signature,
                nonce
            })
        ).toBe(false)
    })

    it("empty nonce is rejected at signing time", () => {
        expect(() => signCommitmentOwnership(r, new Uint8Array(0))).toThrow()
    })
})
