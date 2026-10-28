import { describe, expect, it } from "@jest/globals"
import { createMemberServerClient } from "../src/server/client"
import { MemberServerError } from "../src/server/errors"
import {
    authAddress,
    createFakeFetch,
    metaStealthAddress,
    networkId,
    signedRegistrationRequest,
    safeAddress,
    sponsorship,
    stealthAddress,
    txHash
} from "./support"

const baseUrl = "https://issuer.example"

describe("createMemberServerClient.submitRegistration", () => {
    it("returns submitted on 201, matching apps/issuer-service's registrations route body", async () => {
        const { fetch } = createFakeFetch({
            "/v1/registrations": { status: 201, body: { status: "submitted", txHash } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).resolves.toEqual({
            status: "submitted",
            txHash
        })
    })

    it("carries the sponsorship object through when the paymaster sponsored the registration", async () => {
        const { fetch } = createFakeFetch({
            "/v1/registrations": { status: 201, body: { status: "submitted", txHash, sponsorship } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).resolves.toEqual({
            status: "submitted",
            txHash,
            sponsorship
        })
    })

    it("returns alreadyRegistered on 200 as a value, not a throw", async () => {
        const { fetch } = createFakeFetch({
            "/v1/registrations": {
                status: 200,
                body: { status: "alreadyRegistered", metaStealthAddress, matchesRequest: true }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).resolves.toEqual({
            status: "alreadyRegistered",
            metaStealthAddress,
            matchesRequest: true
        })
    })

    it("throws with the server's own code on a 400 rejection", async () => {
        const { fetch } = createFakeFetch({
            "/v1/registrations": {
                status: 400,
                body: { error: "invalid registration request", code: "INVALID_REGISTRATION_REQUEST" }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).rejects.toMatchObject({
            code: "INVALID_REGISTRATION_REQUEST",
            status: 400
        })
    })

    it("falls back to BAD_REQUEST on a 400 with no server code, e.g. a malformed-body rejection", async () => {
        const { fetch } = createFakeFetch({
            "/v1/registrations": { status: 400, body: { error: "malformed registration request" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).rejects.toMatchObject({
            code: "BAD_REQUEST"
        })
    })

    it("throws with the server's own code on a 503 unavailability", async () => {
        const { fetch } = createFakeFetch({
            "/v1/registrations": { status: 503, body: { error: "registry unavailable", code: "REGISTRY_UNAVAILABLE" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).rejects.toMatchObject({
            code: "REGISTRY_UNAVAILABLE",
            status: 503
        })
    })
})

describe("createMemberServerClient.deliver", () => {
    it("returns announced with txHash on 201", async () => {
        const { fetch } = createFakeFetch({
            "/v1/deliveries": { status: 201, body: { status: "announced", txHash } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).resolves.toEqual({ status: "announced", txHash })
    })

    it("throws INVALID_RESPONSE on a 201 body still carrying stealthAddress", async () => {
        const { fetch } = createFakeFetch({
            "/v1/deliveries": { status: 201, body: { status: "announced", stealthAddress, txHash } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    })

    it("throws INVALID_RESPONSE on a 201 body missing status", async () => {
        const { fetch } = createFakeFetch({ "/v1/deliveries": { status: 201, body: { txHash } } })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    })

    it("throws INVALID_RESPONSE on a 201 body whose status is not 'announced'", async () => {
        const { fetch } = createFakeFetch({ "/v1/deliveries": { status: 201, body: { status: "pending", txHash } } })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    })

    it("sends no Authorization header when the client has no memberServerToken", async () => {
        const { fetch, calls } = createFakeFetch({
            "/v1/deliveries": { status: 201, body: { status: "announced", txHash } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await server.deliver({ networkId })

        expect(calls[0].init?.headers?.Authorization).toBeUndefined()
    })

    it.each([
        [401, "UNAUTHORIZED"],
        [403, "MEMBER_NOT_APPROVED"],
        [404, "REQUEST_FAILED"],
        [422, "DELIVERY_REFUSED"],
        [429, "RATE_LIMITED"],
        [502, "ANNOUNCE_FAILED"],
        [503, "NOT_CONFIGURED"]
    ])("maps a %d response with no server code to %s", async (status, code) => {
        const { fetch } = createFakeFetch({ "/v1/deliveries": { status, body: { error: "delivery failed" } } })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).rejects.toMatchObject({ code, status })
    })

    it("uses the server's own code instead of the status fallback when it sends one", async () => {
        const { fetch } = createFakeFetch({
            "/v1/deliveries": { status: 502, body: { error: "delivery failed", code: "DELIVERY_REFUSED" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).rejects.toMatchObject({ code: "DELIVERY_REFUSED", status: 502 })
    })
})

describe("createMemberServerClient.createPresentationRequest", () => {
    it("returns the request record on 201", async () => {
        const { fetch } = createFakeFetch({
            "/v1/presentation-requests": {
                status: 201,
                body: {
                    requestId: "urn:uuid:req-1",
                    challenge: `0x${"9c".repeat(31)}`,
                    audience: "urn:cn:network:member-server",
                    currentTime: 1_700_000_000,
                    programme: "demo-programme",
                    country: "ZZZ",
                    expiresAt: 1_700_000_300
                }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(
            server.createPresentationRequest({ programme: "demo-programme", country: "ZZZ" })
        ).resolves.toEqual({
            requestId: "urn:uuid:req-1",
            challenge: `0x${"9c".repeat(31)}`,
            audience: "urn:cn:network:member-server",
            currentTime: 1_700_000_000,
            programme: "demo-programme",
            country: "ZZZ",
            expiresAt: 1_700_000_300
        })
    })

    it("falls back to BAD_REQUEST on a non-201 status", async () => {
        const { fetch } = createFakeFetch({
            "/v1/presentation-requests": { status: 400, body: { error: "bad country" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(
            server.createPresentationRequest({ programme: "demo-programme", country: "ZZZ" })
        ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    })
})

describe("createMemberServerClient.closePresentationRequest", () => {
    it("returns the verification id the server recorded the refusal under", async () => {
        const { fetch } = createFakeFetch({
            "/v1/presentation-requests/urn%3Auuid%3Areq-1/close": {
                status: 200,
                body: { verificationId: "urn:uuid:verification-2" }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.closePresentationRequest("urn:uuid:req-1", "CREDENTIAL_REVOKED")).resolves.toEqual({
            verificationId: "urn:uuid:verification-2"
        })
    })

    it("posts the refusal code as the body", async () => {
        const { fetch, calls } = createFakeFetch({
            "/close": { status: 200, body: { verificationId: "urn:uuid:verification-2" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await server.closePresentationRequest("urn:uuid:req-1", "NO_CREDENTIAL")

        expect(calls[0].init?.method).toBe("POST")
        expect(calls[0].init?.body).toBe(JSON.stringify({ code: "NO_CREDENTIAL" }))
    })

    it("throws NOT_FOUND on a 404 for an unknown request", async () => {
        const { fetch } = createFakeFetch({
            "/close": { status: 404, body: { error: "unknown presentation request" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.closePresentationRequest("urn:uuid:req-1", "NO_CREDENTIAL")).rejects.toMatchObject({
            code: "NOT_FOUND"
        })
    })

    it("falls back to REQUEST_FAILED on an unmapped status", async () => {
        const { fetch } = createFakeFetch({ "/v1/presentation-requests/req/close": { status: 500 } })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.closePresentationRequest("req", "NO_CREDENTIAL")).rejects.toMatchObject({
            code: "REQUEST_FAILED",
            status: 500
        })
    })
})

describe("createMemberServerClient.getVerification", () => {
    const record = {
        verificationId: "urn:uuid:verification-1",
        ok: false,
        code: "REVOCATION_ROOT_INVALID",
        issuerLeaf: "42",
        requestId: "urn:uuid:req-1",
        audience: "urn:cn:network:member-server",
        currentTime: 1_700_000_000,
        challenge: `0x${"9c".repeat(31)}`,
        programme: "demo-programme",
        country: "ZZZ",
        verifiedAt: 1_700_000_100
    }

    it("issues a GET and returns the record on 200", async () => {
        const { fetch, calls } = createFakeFetch({
            "/v1/verifications/urn%3Auuid%3Averification-1": { status: 200, body: record }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getVerification("urn:uuid:verification-1")).resolves.toEqual(record)
        expect(calls[0].init?.method).toBe("GET")
    })

    it("sends the member server token", async () => {
        const { fetch, calls } = createFakeFetch({
            "/v1/verifications/urn%3Auuid%3Averification-1": { status: 200, body: record }
        })
        const server = createMemberServerClient({ baseUrl, fetch, memberServerToken: "member-token" })

        await server.getVerification("urn:uuid:verification-1")

        expect(calls[0].init?.headers?.Authorization).toBe("Bearer member-token")
    })

    it("throws UNAUTHORIZED on a 401", async () => {
        const { fetch } = createFakeFetch({
            "/v1/verifications/urn%3Auuid%3Averification-1": {
                status: 401,
                body: { error: "member server token required", code: "UNAUTHORIZED" }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getVerification("urn:uuid:verification-1")).rejects.toMatchObject({
            code: "UNAUTHORIZED",
            status: 401
        })
    })

    it("reads back a record with neither a code nor an issuer leaf", async () => {
        const { verificationId, requestId, audience, currentTime, challenge, programme, country, verifiedAt } = record
        const passed = {
            verificationId,
            ok: true,
            requestId,
            audience,
            currentTime,
            challenge,
            programme,
            country,
            verifiedAt
        }
        const { fetch } = createFakeFetch({
            "/v1/verifications/urn%3Auuid%3Averification-1": { status: 200, body: passed }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getVerification("urn:uuid:verification-1")).resolves.toEqual(passed)
    })

    it("throws NOT_FOUND on a 404 for an unknown verification", async () => {
        const { fetch } = createFakeFetch({
            "/v1/verifications/urn%3Auuid%3Averification-1": { status: 404, body: { error: "unknown verification" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getVerification("urn:uuid:verification-1")).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("throws INVALID_RESPONSE on a 200 body that fails schema validation", async () => {
        const { fetch } = createFakeFetch({
            "/v1/verifications/urn%3Auuid%3Averification-1": { status: 200, body: { ...record, ok: "yes" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getVerification("urn:uuid:verification-1")).rejects.toMatchObject({
            code: "INVALID_RESPONSE"
        })
    })
})

describe("createMemberServerClient.revokeCredential", () => {
    // The id arrives from an operator typing it, or from a listing, so it is percent-encoded: a
    // `/` in it would otherwise change which route is hit. Express decodes the param back, so the
    // server still sees the id the caller meant.
    it("percent-encodes the credential id into the path", async () => {
        const { fetch } = createFakeFetch({
            "/v1/credentials/..%2F..%2Fadmin/revoke": { status: 404, body: { error: "unknown credential" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.revokeCredential("../../admin")).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    it("returns revoked on 200", async () => {
        const { fetch } = createFakeFetch({
            "/v1/credentials/urn%3Auuid%3Acred-1/revoke": {
                status: 200,
                body: { id: "urn:uuid:cred-1", revoked: true }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.revokeCredential("urn:uuid:cred-1")).resolves.toEqual({
            id: "urn:uuid:cred-1",
            revoked: true
        })
    })

    it("throws NOT_FOUND on a 404 for an unknown credential", async () => {
        const { fetch } = createFakeFetch({
            "/v1/credentials/urn%3Auuid%3Amissing/revoke": { status: 404, body: { error: "unknown credential" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.revokeCredential("urn:uuid:missing")).rejects.toMatchObject({
            code: "NOT_FOUND",
            status: 404
        })
    })

    it("falls back to REQUEST_FAILED on an unmapped status", async () => {
        const { fetch } = createFakeFetch({
            "/v1/credentials/urn%3Auuid%3Acred-1/revoke": { status: 500, body: { error: "boom" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.revokeCredential("urn:uuid:cred-1")).rejects.toMatchObject({
            code: "REQUEST_FAILED",
            status: 500
        })
    })
})

describe("createMemberServerClient.getMembership", () => {
    it("returns the membership snapshot on 200", async () => {
        const { fetch } = createFakeFetch({
            "/v1/membership": {
                status: 200,
                body: {
                    networkId,
                    authAddress,
                    governanceSigner: authAddress,
                    metaStealthAddress,
                    status: "requested",
                    safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
                    identityRegistered: false,
                    issuerKeyPublished: false
                }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getMembership()).resolves.toEqual({
            networkId,
            authAddress,
            governanceSigner: authAddress,
            metaStealthAddress,
            status: "requested",
            safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
            identityRegistered: false,
            issuerKeyPublished: false
        })
    })

    it("issues a GET, not a POST", async () => {
        const { fetch, calls } = createFakeFetch({
            "/v1/membership": {
                status: 200,
                body: {
                    networkId,
                    authAddress,
                    governanceSigner: authAddress,
                    metaStealthAddress,
                    status: "none",
                    safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
                    identityRegistered: false,
                    issuerKeyPublished: false
                }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await server.getMembership()

        expect(calls[0]?.init?.method).toBe("GET")
    })

    it("accepts metaStealthAddress, which apps/issuer-service's governance route always sends", async () => {
        const { fetch } = createFakeFetch({
            "/v1/membership": {
                status: 200,
                body: {
                    networkId,
                    authAddress,
                    governanceSigner: authAddress,
                    metaStealthAddress,
                    status: "approved",
                    safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
                    identityRegistered: true,
                    issuerKeyPublished: true
                }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getMembership()).resolves.toEqual({
            networkId,
            authAddress,
            governanceSigner: authAddress,
            metaStealthAddress,
            status: "approved",
            safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
            identityRegistered: true,
            issuerKeyPublished: true
        })
    })
})

describe("createMemberServerClient generic status/body fallbacks", () => {
    it("falls back to a generic message and REQUEST_FAILED for an unmapped status with no body at all", async () => {
        const { fetch } = createFakeFetch({ "/v1/registrations": { status: 500 } })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.submitRegistration(signedRegistrationRequest)).rejects.toMatchObject({
            code: "REQUEST_FAILED",
            status: 500,
            message: "request failed with status 500"
        })
    })

    it("falls back to REQUEST_FAILED for deliver's own unmapped status", async () => {
        const { fetch } = createFakeFetch({ "/v1/deliveries": { status: 500, body: { error: "boom" } } })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.deliver({ networkId })).rejects.toMatchObject({ code: "REQUEST_FAILED" })
    })

    it("falls back to UNAUTHORIZED and RATE_LIMITED for submitRegistration's 401 and 429, with no server code", async () => {
        const server = createMemberServerClient({
            baseUrl,
            fetch: createFakeFetch({ "/v1/registrations": { status: 401, body: {} } }).fetch
        })
        await expect(server.submitRegistration(signedRegistrationRequest)).rejects.toMatchObject({
            code: "UNAUTHORIZED",
            status: 401
        })

        const rateLimited = createMemberServerClient({
            baseUrl,
            fetch: createFakeFetch({ "/v1/registrations": { status: 429, body: {} } }).fetch
        })
        await expect(rateLimited.submitRegistration(signedRegistrationRequest)).rejects.toMatchObject({
            code: "RATE_LIMITED",
            status: 429
        })
    })
})

describe("createMemberServerClient transport failures", () => {
    it("wraps a fetch rejection as REQUEST_FAILED", async () => {
        const fetch = async (): Promise<never> => {
            throw new Error("network down")
        }
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getMembership()).rejects.toMatchObject({
            code: "REQUEST_FAILED"
        })
        await expect(server.getMembership()).rejects.toBeInstanceOf(MemberServerError)
    })

    it("wraps a non-JSON body as INVALID_RESPONSE", async () => {
        const fetch = async () => ({ ok: true, status: 200, text: async () => "not json" })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.getMembership()).rejects.toMatchObject({
            code: "INVALID_RESPONSE"
        })
    })
})

describe("createMemberServerClient and the member server token", () => {
    const memberServerToken = "a-member-server-token-long-enough"
    const authorization = `Bearer ${memberServerToken}`

    it("sends the token on the four routes that act as the member", async () => {
        const { fetch, calls } = createFakeFetch({
            "/revoke": { status: 200, body: { id: "urn:uuid:1", revoked: true } },
            "/v1/membership": {
                status: 200,
                body: {
                    networkId,
                    authAddress,
                    governanceSigner: authAddress,
                    metaStealthAddress,
                    status: "approved",
                    safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
                    identityRegistered: true,
                    issuerKeyPublished: true
                }
            },
            "/v1/registrations": { status: 201, body: { status: "submitted", txHash } },
            "/v1/deliveries": { status: 201, body: { status: "announced", txHash } }
        })
        const server = createMemberServerClient({ baseUrl, fetch, memberServerToken })

        await server.revokeCredential("urn:uuid:1")
        await server.getMembership()
        await server.submitRegistration(signedRegistrationRequest)
        await server.deliver({ networkId })

        expect(calls.map((call) => call.init?.headers?.Authorization)).toEqual([
            authorization,
            authorization,
            authorization,
            authorization
        ])
    })

    // A wallet reaches the presentation-request route without a token. Reading the stored
    // verification is member-side and therefore carries it.
    it("keeps presentation requests open and authenticates stored-verification reads", async () => {
        const { fetch, calls } = createFakeFetch({
            "/v1/presentation-requests": {
                status: 201,
                body: {
                    requestId: "urn:uuid:req-1",
                    challenge: `0x${"9c".repeat(31)}`,
                    audience: "urn:cn:network:member-server",
                    currentTime: 1_700_000_000,
                    programme: "demo-programme",
                    country: "ZZZ",
                    expiresAt: 1_700_000_300
                }
            },
            "/v1/verifications/urn%3Auuid%3Averification-1": {
                status: 200,
                body: {
                    verificationId: "urn:uuid:verification-1",
                    ok: true,
                    requestId: "urn:uuid:req-1",
                    audience: "urn:cn:network:member-server",
                    currentTime: 1_700_000_000,
                    challenge: `0x${"9c".repeat(31)}`,
                    programme: "demo-programme",
                    country: "ZZZ",
                    verifiedAt: 1_700_000_100
                }
            }
        })
        const server = createMemberServerClient({ baseUrl, fetch, memberServerToken })

        await server.createPresentationRequest({ programme: "demo-programme", country: "ZZZ" })
        await server.getVerification("urn:uuid:verification-1")

        expect(calls.map((call) => call.init?.headers?.Authorization)).toEqual([undefined, authorization])
    })

    it("reports a 401 as UNAUTHORIZED, so a screen can say this install does not hold the token", async () => {
        const { fetch } = createFakeFetch({
            "/revoke": { status: 401, body: { error: "member server token required", code: "UNAUTHORIZED" } },
            "/v1/membership": { status: 401, body: { error: "member server token required", code: "UNAUTHORIZED" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })

        await expect(server.revokeCredential("urn:uuid:1")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
        await expect(server.getMembership()).rejects.toBeInstanceOf(MemberServerError)
    })
})

describe("cross-device presentation status", () => {
    it("returns 409 when a submitted presentation cannot be cancelled", async () => {
        const { fetch } = createFakeFetch({
            "/v1/presentation-requests/req/cancel": { status: 409, body: { error: "request already submitted" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch })
        await expect(server.cancelPresentationRequest("req")).resolves.toBe(409)
    })
    it("authenticates request-ID reads and cancellation, encoding an untrusted ID as one path segment", async () => {
        const id = "request/with?special#characters"
        const path = `/v1/presentation-requests/${encodeURIComponent(id)}`
        const { fetch, calls } = createFakeFetch({
            [path]: { status: 200, body: { status: "pending" } },
            [`${path}/cancel`]: { status: 200, body: { status: "cancelled" } }
        })
        const server = createMemberServerClient({ baseUrl, fetch, memberServerToken: "secret-token" })
        await expect(server.getPresentationStatus(id)).resolves.toEqual({ status: "pending" })
        await expect(server.cancelPresentationRequest(id)).resolves.toBe(200)
        expect(calls).toHaveLength(2)
        for (const call of calls) expect(call.init?.headers?.Authorization).toBe("Bearer secret-token")
    })
    it("fails closed on unauthenticated or malformed status responses", async () => {
        for (const response of [
            { status: 401, body: { error: "token required" } },
            { status: 200, body: { status: "completed", verification: { ok: true } } }
        ]) {
            const { fetch } = createFakeFetch({ "/v1/presentation-requests/req": response })
            const server = createMemberServerClient({ baseUrl, fetch })
            await expect(server.getPresentationStatus("req")).rejects.toThrow()
        }
    })
})

describe("createMemberServerClient status fallbacks", () => {
    it.each<
        [
            method: "getPresentationStatus" | "cancelPresentationRequest" | "getVerification" | "getMembership",
            status: number,
            code: string
        ]
    >([
        ["getPresentationStatus", 401, "UNAUTHORIZED"],
        ["getPresentationStatus", 404, "NOT_FOUND"],
        ["getPresentationStatus", 410, "NOT_FOUND"],
        ["getPresentationStatus", 500, "REQUEST_FAILED"],
        ["getVerification", 500, "REQUEST_FAILED"],
        ["getMembership", 401, "UNAUTHORIZED"],
        ["getMembership", 500, "REQUEST_FAILED"],
        ["cancelPresentationRequest", 404, "REQUEST_FAILED"]
    ])("%s maps a %i without a server code to %s", async (method, status, code) => {
        const { fetch } = createFakeFetch({
            "/v1/presentation-requests/req": { status },
            "/v1/presentation-requests/req/cancel": { status },
            "/v1/verifications/req": { status },
            "/v1/membership": { status }
        })
        const server = createMemberServerClient({ baseUrl, fetch })
        const call = method === "getMembership" ? server.getMembership() : server[method]("req")

        await expect(call).rejects.toMatchObject({ code, status })
    })
})
