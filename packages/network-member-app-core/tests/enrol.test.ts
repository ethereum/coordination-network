import { describe, expect, it, jest } from "@jest/globals"
import { LinkError } from "@coordination-network/user-app-link"
import { enrol } from "../src/flows/enrol"
import type { MemberContext } from "../src/context"
import {
    config,
    createFakeLinkClient,
    createFakePolicy,
    createFakeServer,
    metaStealthAddress,
    registrationSignResult,
    signedRegistrationRequest,
    sponsorship,
    subject,
    txHash
} from "./support"

function buildContext(overrides: Partial<MemberContext> = {}): MemberContext {
    const { client } = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
    return {
        config,
        link: client,
        server: createFakeServer({ submitRegistration: async () => ({ status: "submitted", txHash }) }),
        policy: createFakePolicy(),
        ...overrides
    }
}

describe("enrol", () => {
    it("registers a fresh subject, posting the signed request the wallet returned", async () => {
        const submitRegistration = jest.fn(async () => ({ status: "submitted" as const, txHash }))
        const ctx = buildContext({ server: createFakeServer({ submitRegistration }) })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({ status: "registered", subject, txHash })
        expect(submitRegistration).toHaveBeenCalledWith(signedRegistrationRequest)
    })

    it("asks the wallet for nothing but the signature, deriving the subject from what it signed", async () => {
        const decideEnrolment = jest.fn(async () => ({ approved: true as const, value: undefined }))
        const { client, calls } = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
        const ctx = buildContext({ link: client, policy: createFakePolicy({ decideEnrolment }) })

        await enrol(ctx)

        expect(calls.map((call) => call.op)).toEqual(["registration.sign"])
        expect(decideEnrolment).toHaveBeenCalledWith(subject)
    })

    it("carries the server's sponsorship facts through to the outcome", async () => {
        const ctx = buildContext({
            server: createFakeServer({ submitRegistration: async () => ({ status: "submitted", txHash, sponsorship }) })
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({ status: "registered", subject, txHash, sponsorship })
    })

    it("treats the server's alreadyRegistered response as a success, not an error", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                submitRegistration: async () => ({
                    status: "alreadyRegistered",
                    metaStealthAddress,
                    matchesRequest: true
                })
            })
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({ status: "alreadyRegistered", subject, metaStealthAddress, matchesRequest: true })
    })

    it("returns refused when policy declines enrolment, without calling the server", async () => {
        const submitRegistration = jest.fn(async () => ({ status: "submitted" as const, txHash }))
        const ctx = buildContext({
            policy: createFakePolicy({
                decideEnrolment: async () => ({ approved: false, reason: "over capacity", code: "CAPACITY" })
            }),
            server: createFakeServer({ submitRegistration })
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({ status: "refused", reason: "over capacity", code: "CAPACITY" })
        expect(submitRegistration).not.toHaveBeenCalled()
    })

    it("reports a failed outcome with stage registration.sign when the link rejects that step", async () => {
        const { client } = createFakeLinkClient({
            "registration.sign": async () => {
                throw new LinkError("USER_DENIED")
            }
        })
        const ctx = buildContext({ link: client })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({
            status: "failed",
            stage: "registration.sign",
            error: { message: "USER_DENIED", code: "USER_DENIED" }
        })
    })

    it("reports a failed outcome with stage policy when the policy throws", async () => {
        const ctx = buildContext({
            policy: createFakePolicy({
                decideEnrolment: async () => {
                    throw new Error("policy backend unreachable")
                }
            })
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({ status: "failed", stage: "policy", error: { message: "policy backend unreachable" } })
    })

    it("reports a failed outcome with stage registrations when the server submission throws", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                submitRegistration: async () => {
                    throw new Error("registry unavailable")
                }
            })
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({
            status: "failed",
            stage: "registrations",
            error: { message: "registry unavailable" }
        })
    })

    it("calls onEnrolled on success and never fails the flow when the hook itself throws", async () => {
        const onError = jest.fn((): void => {})
        const ctx = buildContext({
            hooks: {
                onEnrolled: () => {
                    throw new Error("hook boom")
                },
                onError
            }
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({ status: "registered", subject, txHash })
        expect(onError).toHaveBeenCalledWith({ flow: "enrol", stage: "registrations", error: expect.any(Error) })
    })

    it("still returns the failed outcome when onError itself throws", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                submitRegistration: async () => {
                    throw new Error("registry unavailable")
                }
            }),
            hooks: {
                onError: () => {
                    throw new Error("onError boom")
                }
            }
        })

        const outcome = await enrol(ctx)

        expect(outcome).toEqual({
            status: "failed",
            stage: "registrations",
            error: { message: "registry unavailable" }
        })
    })
})
