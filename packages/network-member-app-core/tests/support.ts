import type { LinkClient, LinkOp, Params, Result } from "@coordination-network/user-app-link"
import type { FetchLike, MemberServerClient, Sponsorship } from "../src/server/client"
import type { MemberPolicy } from "../src/business"

/** Fake `LinkClient`: each op resolves (or throws) via a handler the test registers, no protocol codec involved. */
export type FakeLinkHandlers = {
    [Op in LinkOp]?: (params: Params<Op>) => Result<Op> | Promise<Result<Op>>
}

export interface FakeLinkClient {
    client: LinkClient
    calls: Array<{ op: LinkOp; params: unknown }>
}

export function createFakeLinkClient(handlers: FakeLinkHandlers): FakeLinkClient {
    const calls: Array<{ op: LinkOp; params: unknown }> = []
    return {
        calls,
        client: {
            request: (async (op: LinkOp, params: unknown) => {
                calls.push({ op, params })
                // Every test registers the ops its flow actually calls; an unregistered op is a
                // mistake in the test itself, so this is left to throw its own TypeError.
                const handler = handlers[op] as (params: unknown) => unknown
                return handler(params)
            }) as LinkClient["request"]
        }
    }
}

export interface FakeRoute {
    status: number
    body?: unknown
    /** Overrides `body`/`JSON.stringify` - lets a test send malformed JSON, or no body at all. */
    text?: string
}

export interface FakeFetch {
    fetch: FetchLike
    calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }>
}

/** Fake `FetchLike`, keyed by URL suffix (e.g. `/v1/challenge`), one route per key. */
export function createFakeFetch(routes: Record<string, FakeRoute>): FakeFetch {
    const calls: FakeFetch["calls"] = []

    const fetch: FetchLike = async (url, init) => {
        calls.push({ url, init })
        const path = Object.keys(routes).find((candidate) => url.endsWith(candidate))
        if (!path) {
            throw new Error(`no fake route registered for ${url}`)
        }
        const route = routes[path]
        const text = route.text ?? (route.body === undefined ? "" : JSON.stringify(route.body))
        return { ok: route.status < 400, status: route.status, text: async () => text }
    }

    return { fetch, calls }
}

function hex(byteLength: number, byte: string): `0x${string}` {
    return `0x${byte.repeat(byteLength)}` as `0x${string}`
}

export const networkId = hex(32, "11")
export const issuerNetworkId = hex(32, "77")
export const metaStealthAddress = hex(66, "22")
export const verifyingContract = hex(20, "44")
export const txHash = hex(32, "aa")
export const stealthAddress = hex(20, "bb")
export const authAddress = hex(20, "cc")
export const governanceSigner = hex(20, "dd")
export const safeAddress = hex(20, "ee")

export const sponsorship: Sponsorship = {
    sender: hex(20, "01"),
    senderBalanceBefore: "0",
    senderBalanceAfter: "0",
    userOpHash: hex(32, "02"),
    bundleTxHash: hex(32, "03"),
    actualGasCost: "1234567",
    paymaster: hex(20, "04"),
    paymasterDepositBefore: "1000000000000000000",
    paymasterDepositAfter: "998765432100000000"
}

export const signedRegistrationRequest = {
    version: "v1" as const,
    networkId,
    schemeId: 1 as const,
    metaStealthAddress,
    chainId: 1,
    verifyingContract,
    signature: hex(65, "55")
}

export const registrationSignResult = {
    request: signedRegistrationRequest,
    securityLevel: "SOFTWARE" as const
}

export const subject = {
    networkId,
    metaStealthAddress,
    securityLevel: registrationSignResult.securityLevel
}

export const verificationRecord = {
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

/** Every port throws by default, so a test only has to override the methods its flow actually calls. */
export function createFakeServer(overrides: Partial<MemberServerClient> = {}): MemberServerClient {
    const notStubbed = (name: string) => async (): Promise<never> => {
        throw new Error(`fake server: ${name} was not stubbed for this test`)
    }
    return {
        submitRegistration: notStubbed("submitRegistration"),
        deliver: notStubbed("deliver"),
        createPresentationRequest: notStubbed("createPresentationRequest"),
        closePresentationRequest: notStubbed("closePresentationRequest"),
        getPresentationStatus: async () => ({ status: "pending" as const }),
        cancelPresentationRequest: async () => 200,
        getVerification: notStubbed("getVerification"),
        revokeCredential: notStubbed("revokeCredential"),
        getMembership: notStubbed("getMembership"),
        ...overrides
    }
}

export function createFakePolicy(overrides: Partial<MemberPolicy> = {}): MemberPolicy {
    return {
        decideEnrolment: async () => ({ approved: true, value: undefined }),
        decideIssuance: async () => ({ approved: true, value: { programme: "demo-programme", country: "ZZZ" } }),
        ...overrides
    }
}

export const config = {
    networkId: issuerNetworkId,
    displayName: "Member A",
    serverUrl: "https://issuer.example",
    registry: { chainId: 1, verifyingContract },
    memberServerToken: "member-token-a"
}
