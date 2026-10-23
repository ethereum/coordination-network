import { describe, expect, it, jest } from "@jest/globals"
import { createHttpRegistrationSubmitter, HttpSubmissionError } from "../src/http-submitter"
import { RegistrationRequest } from "../src/types"

const request: RegistrationRequest = {
    version: "v1",
    networkId: `0x${"11".repeat(32)}`,
    schemeId: 1,
    metaStealthAddress: `0x${"22".repeat(33)}`,
    chainId: 1,
    verifyingContract: `0x${"33".repeat(20)}`,
    signature: `0x${"44".repeat(65)}`
}

const VALID_TX_HASH = `0x${"aa".repeat(32)}`

function mockFetch(status: number, body: unknown) {
    return jest.fn<typeof fetch>(async () => ({ status, json: async () => body }) as Response)
}

async function catchError(fetchImpl: typeof fetch): Promise<unknown> {
    const submitter = createHttpRegistrationSubmitter({ url: "https://member.example", fetch: fetchImpl })
    return submitter.submit(request).catch((caught: unknown) => caught)
}

describe("createHttpRegistrationSubmitter", () => {
    it("POSTs the request as JSON to <url>/v1/registrations", async () => {
        const fetch = mockFetch(201, { status: "submitted", txHash: VALID_TX_HASH })
        const submitter = createHttpRegistrationSubmitter({ url: "https://member.example", fetch })

        await submitter.submit(request)

        expect(fetch).toHaveBeenCalledWith("https://member.example/v1/registrations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request)
        })
    })

    it("201: resolves with the txHash", async () => {
        const fetch = mockFetch(201, { status: "submitted", txHash: VALID_TX_HASH })
        const submitter = createHttpRegistrationSubmitter({ url: "https://member.example", fetch })

        await expect(submitter.submit(request)).resolves.toEqual({ txHash: VALID_TX_HASH })
    })

    it("201 with a missing txHash: throws HttpSubmissionError(invalidResponse)", async () => {
        const error = await catchError(mockFetch(201, { status: "submitted" }))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("invalidResponse")
        expect((error as HttpSubmissionError).status).toBe(201)
    })

    it("201 with a txHash that isn't a 32-byte 0x hex string: throws HttpSubmissionError(invalidResponse)", async () => {
        const error = await catchError(mockFetch(201, { status: "submitted", txHash: "0xabc" }))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("invalidResponse")
        expect((error as HttpSubmissionError).status).toBe(201)
    })

    it("500: throws HttpSubmissionError(invalidResponse), not (unavailable) - only 503 and 429 map to unavailable", async () => {
        const error = await catchError(mockFetch(500, { code: "INTERNAL" }))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("invalidResponse")
        expect((error as HttpSubmissionError).status).toBe(500)
    })

    it("200 alreadyRegistered: throws HttpSubmissionError carrying the registry's entry", async () => {
        const error = await catchError(
            mockFetch(200, {
                status: "alreadyRegistered",
                metaStealthAddress: request.metaStealthAddress,
                matchesRequest: false
            })
        )

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect(error).toMatchObject({
            reason: "alreadyRegistered",
            status: 200,
            metaStealthAddress: request.metaStealthAddress,
            matchesRequest: false
        })
    })

    it("400: throws HttpSubmissionError(rejected)", async () => {
        const error = await catchError(mockFetch(400, {}))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("rejected")
        expect((error as HttpSubmissionError).status).toBe(400)
    })

    it("503 with a server code: throws HttpSubmissionError(unavailable) carrying it", async () => {
        const error = await catchError(mockFetch(503, { code: "DOWNSTREAM_TIMEOUT" }))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("unavailable")
        expect((error as HttpSubmissionError).serverCode).toBe("DOWNSTREAM_TIMEOUT")
    })

    it("503 without a server code: code is undefined", async () => {
        const error = await catchError(mockFetch(503, {}))

        expect((error as HttpSubmissionError).serverCode).toBeUndefined()
    })

    it("401: throws HttpSubmissionError(unauthorized)", async () => {
        const error = await catchError(mockFetch(401, { error: "member server token required", code: "UNAUTHORIZED" }))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("unauthorized")
        expect((error as HttpSubmissionError).status).toBe(401)
    })

    it("429: throws HttpSubmissionError(unavailable) carrying the RATE_LIMITED server code", async () => {
        const error = await catchError(mockFetch(429, { error: "rate limit exceeded", code: "RATE_LIMITED" }))

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("unavailable")
        expect((error as HttpSubmissionError).status).toBe(429)
        expect((error as HttpSubmissionError).serverCode).toBe("RATE_LIMITED")
    })

    it("sends Authorization: Bearer <memberServerToken> when one is set", async () => {
        const fetch = mockFetch(201, { status: "submitted", txHash: VALID_TX_HASH })
        const submitter = createHttpRegistrationSubmitter({
            url: "https://member.example",
            fetch,
            memberServerToken: "a-member-server-token-long-enough"
        })

        await submitter.submit(request)

        expect(fetch).toHaveBeenCalledWith("https://member.example/v1/registrations", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer a-member-server-token-long-enough"
            },
            body: JSON.stringify(request)
        })
    })

    it("network failure: throws HttpSubmissionError(network) with the cause", async () => {
        const networkError = new Error("fetch failed")
        const fetchImpl = jest.fn<typeof fetch>(async () => {
            throw networkError
        })

        const error = await catchError(fetchImpl)

        expect(error).toBeInstanceOf(HttpSubmissionError)
        expect((error as HttpSubmissionError).reason).toBe("network")
        expect((error as HttpSubmissionError).cause).toBe(networkError)
    })

    it("never includes the request signature in an error message", async () => {
        const error = await catchError(mockFetch(400, {}))

        expect((error as Error).message).not.toContain(request.signature)
    })
})
