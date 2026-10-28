import { SNARK_SCALAR_FIELD } from "@coordination-network/issuer-set"
import { parseZkCredential, serializeZkCredential, verifyZkCredential } from "../src/credential-message"
import type { SerializedZkCredential, ZkCredential } from "../src/types"
import { createZkFixture } from "./fixtures"

describe("serialized credential validation", () => {
    let credential: SerializedZkCredential

    beforeAll(async () => {
        credential = (await createZkFixture()).credential
    })

    it("round-trips a signed credential without changing its signature or commitments", () => {
        const parsed = parseZkCredential(credential)
        expect(serializeZkCredential(parsed)).toEqual(credential)
        expect(verifyZkCredential(parsed)).toBe(true)
    })

    it.each([null, [], "credential"])("rejects a non-object credential %p", (value) => {
        expect(() => parseZkCredential(value)).toThrow("credential must be an object")
    })

    it("rejects an unknown field even when it replaces an expected field", () => {
        const { signature, ...rest } = credential
        expect(() => parseZkCredential({ ...rest, unknown: signature })).toThrow("credential has unexpected fields")
    })

    it.each(["body", "signature"] as const)("rejects extra %s fields", (field) => {
        const value = structuredClone(credential)
        if (field === "signature") Object.assign(value.signature, { extra: true })
        else Object.assign(value.body, { extra: true })
        expect(() => parseZkCredential(value)).toThrow("unexpected fields")
    })

    it.each([null, "key", [], ["1"], ["1", "2", "3"]])("rejects a malformed issuer key %p", (issuerPublicKey) => {
        expect(() => parseZkCredential({ ...credential, issuerPublicKey })).toThrow(
            "issuerPublicKey must contain two values"
        )
    })

    it.each([null, "point", [], ["1"], ["1", "2", "3"]])("rejects a malformed signature point %p", (R8) => {
        expect(() => parseZkCredential({ ...credential, signature: { ...credential.signature, R8 } })).toThrow(
            "signature.R8 must contain two values"
        )
    })

    it.each(["-1", "01", "1.5", "", 1, SNARK_SCALAR_FIELD.toString()])(
        "rejects a non-canonical or overflowing field %p",
        (programmeHash) => {
            expect(() => parseZkCredential({ ...credential, body: { ...credential.body, programmeHash } })).toThrow(
                /decimal|BN254 field/
            )
        }
    )

    it.each(["notBefore", "expiresAt"] as const)("rejects invalid %s values", (field) => {
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123", NaN]) {
            expect(() => parseZkCredential({ ...credential, body: { ...credential.body, [field]: value } })).toThrow(
                "non-negative integer"
            )
        }
    })

    it.each([-1, 0x1000000, 1.5, "123", NaN])(
        "rejects a country code outside the three-byte integer domain: %p",
        (countryCode) => {
            expect(() => parseZkCredential({ ...credential, body: { ...credential.body, countryCode } })).toThrow(
                "three-byte integer"
            )
        }
    )

    it.each([0, 1])("rejects a validity window ending %i seconds before its start", (offset) => {
        const body = { ...credential.body, expiresAt: credential.body.notBefore - offset }
        expect(() => parseZkCredential({ ...credential, body })).toThrow("credential validity window is invalid")
    })

    it("returns false for an invalid runtime signature shape instead of exposing a verifier exception", () => {
        const parsed = parseZkCredential(credential)
        expect(verifyZkCredential({ ...parsed, signature: null } as unknown as ZkCredential)).toBe(false)
    })
})
