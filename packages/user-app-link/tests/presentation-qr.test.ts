import { describe, it, expect } from "@jest/globals"
import { decodePresentationQr, encodePresentationQr, base64UrlEncode } from "../src"
import { presentationCreateParams } from "./fixtures"

const value = { params: presentationCreateParams, expiresAt: 1700000300 }

describe("presentation QR", () => {
    it("round trips a public challenge without callback, token, credential or proof", () => {
        const raw = encodePresentationQr(value)
        expect(raw.length).toBeLessThanOrEqual(2000)
        expect(decodePresentationQr(raw)).toEqual(value)
        expect(raw).not.toContain("memberapp://")
    })
    it.each(["stack.json", "cn-present:v2:abc", "cn-present:v1:not-base64", "cn-present:v1:" + "a".repeat(2000)])(
        "rejects malformed or unsupported data: %s",
        (raw) => {
            expect(() => decodePresentationQr(raw)).toThrow()
        }
    )
    it("rejects unknown fields and split-origin proof delivery", () => {
        expect(() => encodePresentationQr({ ...value, token: "secret" } as typeof value)).toThrow()
        expect(() =>
            encodePresentationQr({
                ...value,
                params: { ...value.params, responseUrl: "https://attacker.example/v1/verify" }
            })
        ).toThrow()
        const raw =
            "cn-present:v1:" + base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...value, proof: "secret" })))
        expect(() => decodePresentationQr(raw)).toThrow()
    })
})

it("never encodes basic-auth credentials or query tokens in a public challenge", () => {
    const base = "https://user:secret@member.example"
    expect(() =>
        encodePresentationQr({
            ...value,
            params: {
                ...value.params,
                issuersUrl: `${base}/v1/issuers`,
                revocationsUrl: `${base}/v1/revocations/snapshot`,
                responseUrl: `${base}/v1/verify`
            }
        })
    ).toThrow()
})
