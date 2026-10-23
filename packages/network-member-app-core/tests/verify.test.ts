import { describe, expect, it, jest } from "@jest/globals"
import { LinkError } from "@coordination-network/user-app-link"
import { verify } from "../src/flows/verify"
import type { MemberContext } from "../src/context"
import { config, createFakeLinkClient, createFakePolicy, createFakeServer, verificationRecord } from "./support"

const presentationRequest = {
    requestId: "urn:uuid:req-1",
    challenge: `0x${"9c".repeat(31)}` as const,
    audience: "urn:cn:network:member-server",
    currentTime: 1_700_000_000,
    programme: "demo-programme",
    country: "ZZZ",
    expiresAt: 1_700_000_300
}

const scope = { programme: "demo-programme", country: "ZZZ" }

function buildContext(overrides: Partial<MemberContext> = {}): MemberContext {
    const { client } = createFakeLinkClient({
        "presentation.create": async () => ({ verificationId: "urn:uuid:verification-1" })
    })
    return {
        config,
        link: client,
        server: createFakeServer({
            createPresentationRequest: async () => presentationRequest,
            getVerification: async () => verificationRecord
        }),
        policy: createFakePolicy(),
        ...overrides
    }
}

describe("verify", () => {
    it("returns verified when this member's own server recorded a pass", async () => {
        const outcome = await verify(buildContext(), scope)

        expect(outcome).toEqual({
            status: "verified",
            verificationId: "urn:uuid:verification-1",
            programme: "demo-programme",
            country: "ZZZ"
        })
    })

    it("reads the verdict under the id the wallet returned, not from the wallet itself, only once the record's requestId matches this request's", async () => {
        const getVerification = jest.fn(async () => verificationRecord)
        const ctx = buildContext({
            server: createFakeServer({ createPresentationRequest: async () => presentationRequest, getVerification })
        })

        await verify(ctx, scope)

        expect(getVerification).toHaveBeenCalledWith("urn:uuid:verification-1")
    })

    it("fails at stage verifications when the record belongs to another request", async () => {
        const onVerified = jest.fn((): void => {})
        const ctx = buildContext({
            server: createFakeServer({
                createPresentationRequest: async () => presentationRequest,
                getVerification: async () => ({ ...verificationRecord, requestId: "urn:uuid:req-other" })
            }),
            hooks: { onVerified }
        })

        const outcome = await verify(ctx, scope)

        expect(outcome).toEqual({
            status: "failed",
            stage: "verifications",
            error: { message: "verification record belongs to another request" }
        })
        expect(onVerified).not.toHaveBeenCalled()
    })

    it("forwards the presentation request's own fields, and this member's own lists, as presentation.create's params", async () => {
        const { client, calls } = createFakeLinkClient({
            "presentation.create": async () => ({ verificationId: "urn:uuid:verification-1" })
        })

        await verify(buildContext({ link: client }), scope)

        expect(calls[0].params).toEqual({
            requestId: presentationRequest.requestId,
            challenge: presentationRequest.challenge,
            audience: presentationRequest.audience,
            currentTime: presentationRequest.currentTime,
            programme: presentationRequest.programme,
            country: presentationRequest.country,
            issuersUrl: "https://issuer.example/v1/issuers",
            revocationsUrl: "https://issuer.example/v1/revocations/snapshot",
            responseUrl: "https://issuer.example/v1/verify"
        })
    })

    it("reports each stage as it is entered, and asks the server for nothing but the scope", async () => {
        const stages: string[] = []
        const createPresentationRequest = jest.fn(async () => presentationRequest)
        const ctx = buildContext({
            server: createFakeServer({ createPresentationRequest, getVerification: async () => verificationRecord })
        })

        await verify(ctx, { ...scope, onStage: (stage) => stages.push(stage) })

        expect(stages).toEqual(["presentationRequests", "presentation.create", "verifications"])
        expect(createPresentationRequest).toHaveBeenCalledWith(scope)
    })

    it("returns rejected with the server's own recorded code", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                createPresentationRequest: async () => presentationRequest,
                getVerification: async () => ({
                    ...verificationRecord,
                    ok: false,
                    code: "ISSUER_ROOT_MISMATCH",
                    issuerLeaf: "42"
                })
            })
        })

        const outcome = await verify(ctx, scope)

        expect(outcome).toEqual({
            status: "rejected",
            code: "ISSUER_ROOT_MISMATCH",
            verificationId: "urn:uuid:verification-1",
            programme: "demo-programme",
            country: "ZZZ"
        })
    })

    it.each(["CREDENTIAL_REVOKED", "NO_CREDENTIAL"] as const)(
        "closes the request and rejects with the code when the wallet answers %s",
        async (code) => {
            const closePresentationRequest = jest.fn(async () => ({ verificationId: "urn:uuid:verification-2" }))
            const { client } = createFakeLinkClient({
                "presentation.create": async () => {
                    throw new LinkError(code)
                }
            })
            const ctx = buildContext({
                link: client,
                server: createFakeServer({
                    createPresentationRequest: async () => presentationRequest,
                    closePresentationRequest
                })
            })

            const outcome = await verify(ctx, scope)

            expect(outcome).toEqual({
                status: "rejected",
                code,
                verificationId: "urn:uuid:verification-2",
                programme: "demo-programme",
                country: "ZZZ"
            })
            expect(closePresentationRequest).toHaveBeenCalledWith(presentationRequest.requestId, code)
        }
    )

    it("reports a failed outcome with stage presentationRequests when the server call throws", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                createPresentationRequest: async () => {
                    throw new Error("presentation-requests service down")
                }
            })
        })

        const outcome = await verify(ctx, scope)

        expect(outcome).toEqual({
            status: "failed",
            stage: "presentationRequests",
            error: { message: "presentation-requests service down" }
        })
    })

    it("reports a failed outcome with stage presentationRequests when closing a refused request throws", async () => {
        const { client } = createFakeLinkClient({
            "presentation.create": async () => {
                throw new LinkError("CREDENTIAL_REVOKED")
            }
        })
        const ctx = buildContext({
            link: client,
            server: createFakeServer({
                createPresentationRequest: async () => presentationRequest,
                closePresentationRequest: async () => {
                    throw new Error("close failed")
                }
            })
        })

        const outcome = await verify(ctx, scope)

        expect(outcome).toEqual({
            status: "failed",
            stage: "presentationRequests",
            error: { message: "close failed" }
        })
    })

    it("reports a failed outcome with stage presentation.create when the link rejects for any other reason", async () => {
        const { client } = createFakeLinkClient({
            "presentation.create": async () => {
                throw new LinkError("PROOF_FAILED")
            }
        })

        const outcome = await verify(buildContext({ link: client }), scope)

        expect(outcome).toEqual({
            status: "failed",
            stage: "presentation.create",
            error: { message: "PROOF_FAILED", code: "PROOF_FAILED" }
        })
    })

    it("reports a failed outcome with stage verifications when the record can't be read back", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                createPresentationRequest: async () => presentationRequest,
                getVerification: async () => {
                    throw new Error("unknown verification")
                }
            })
        })

        const outcome = await verify(ctx, scope)

        expect(outcome).toEqual({
            status: "failed",
            stage: "verifications",
            error: { message: "unknown verification" }
        })
    })

    it("calls onVerified for an accepted presentation, and never fails the flow when the hook throws", async () => {
        const onError = jest.fn((): void => {})
        const ctx = buildContext({
            hooks: {
                onVerified: () => {
                    throw new Error("hook boom")
                },
                onError
            }
        })

        await verify(ctx, scope)

        expect(onError).toHaveBeenCalledWith({ flow: "verify", stage: "verifications", error: expect.any(Error) })
    })

    it("calls onVerified for a request closed on the wallet's refusal too", async () => {
        const onVerified = jest.fn((): void => {})
        const { client } = createFakeLinkClient({
            "presentation.create": async () => {
                throw new LinkError("NO_CREDENTIAL")
            }
        })
        const ctx = buildContext({
            link: client,
            server: createFakeServer({
                createPresentationRequest: async () => presentationRequest,
                closePresentationRequest: async () => ({ verificationId: "urn:uuid:verification-2" })
            }),
            hooks: { onVerified }
        })

        await verify(ctx, scope)

        expect(onVerified).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", code: "NO_CREDENTIAL" }))
    })
})
