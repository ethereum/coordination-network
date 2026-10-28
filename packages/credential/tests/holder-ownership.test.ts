import { randomBytes } from "@noble/hashes/utils"
import { signHolderKeyOwnership, verifyHolderKeyOwnership } from "../src/holder-ownership"

describe("holder key ownership", () => {
    const seed = randomBytes(32)
    const nonce = randomBytes(32)
    const ownership = signHolderKeyOwnership(seed, nonce)

    it("accepts the holder's signature over the issuer challenge", () => {
        expect(verifyHolderKeyOwnership({ ...ownership, nonce })).toBe(true)
    })

    it("rejects replay against a different challenge", () => {
        expect(verifyHolderKeyOwnership({ ...ownership, nonce: randomBytes(32) })).toBe(false)
    })

    it("rejects a signature made by a different holder", () => {
        const other = signHolderKeyOwnership(randomBytes(32), nonce)
        expect(
            verifyHolderKeyOwnership({
                publicKey: ownership.publicKey,
                signature: other.signature,
                nonce
            })
        ).toBe(false)
    })

    it("rejects malformed inputs without throwing", () => {
        expect(
            verifyHolderKeyOwnership({
                publicKey: [1n, 2n],
                signature: ownership.signature,
                nonce
            })
        ).toBe(false)
        expect(() => signHolderKeyOwnership(new Uint8Array(31), nonce)).toThrow("identity seed must be 32 bytes")
        expect(verifyHolderKeyOwnership({ ...ownership, nonce: new Uint8Array() })).toBe(false)
    })
})
