import type {
    FetchLike,
    MemberConfig,
    MemberContext,
    MemberFlows,
    MemberServerClient
} from "@coordination-network/network-member-app-core"
import { createMemberFlows } from "@coordination-network/network-member-app-core"
import type { LinkClient, LinkOp, Params, Result } from "@coordination-network/user-app-link"
import { act } from "react-test-renderer"
import type { ReactTestRenderer } from "react-test-renderer"
import { business } from "../src/business"
import type { Pairing, StackDescriptor } from "../src/config"

/**
 * Presses a `Disclosure`'s toggle by the `testID` given to it. `findByProps` alone would match
 * `Disclosure` itself first - it forwards `testID` down to its `Pressable`, but not `onPress`.
 */
export async function openDisclosure(tree: ReactTestRenderer, testID: string): Promise<void> {
    const [toggle] = tree.root.findAll(
        (node) => node.props.testID === testID && typeof node.props.onPress === "function"
    )
    await act(async () => {
        toggle.props.onPress()
    })
}

/** Fake `LinkClient`: each op resolves (or throws) via a handler the test registers - no protocol codec involved. */
export type FakeLinkHandlers = {
    [Op in LinkOp]?: (params: Params<Op>) => Result<Op> | Promise<Result<Op>>
}

export function createFakeLinkClient(handlers: FakeLinkHandlers): LinkClient {
    return {
        request: (async (op: LinkOp, params: unknown) => {
            // Every test registers the ops its flow actually calls; an unregistered op is a
            // mistake in the test itself, so this is left to throw its own TypeError.
            const handler = handlers[op] as (params: unknown) => unknown
            return handler(params)
        }) as LinkClient["request"]
    }
}

export interface FakeRoute {
    status: number
    body?: unknown
}

/** Fake `FetchLike`, keyed by URL suffix (e.g. `/v1/challenge`), one route per key. */
export function createFakeFetch(routes: Record<string, FakeRoute>): FetchLike {
    return async (url) => {
        const path = Object.keys(routes).find((candidate) => url.endsWith(candidate))
        if (!path) {
            throw new Error(`no fake route registered for ${url}`)
        }
        const route = routes[path]
        const text = route.body === undefined ? "" : JSON.stringify(route.body)
        return { ok: route.status < 400, status: route.status, text: async () => text }
    }
}

export function hex(byteLength: number, byte: string): `0x${string}` {
    return `0x${byte.repeat(byteLength)}` as `0x${string}`
}

/** A realistic two-member `stack.json`, shaped like what `yarn stack` writes and the dashboard's QR points at. */
export function fakeStack(): StackDescriptor {
    return {
        rpcUrl: "http://192.168.1.50:8646",
        chainId: 31337,
        identityRegistry: hex(20, "10"),
        announcer: hex(20, "20"),
        revocation: { address: hex(20, "30"), registry: hex(20, "3a"), registryId: "1" },
        semaphore: hex(20, "40"),
        networkMemberRegistry: hex(20, "50"),
        networkMemberGroup: hex(20, "60"),
        networkMemberGovernance: hex(20, "70"),
        approvedIssuerSet: hex(20, "80"),
        governanceSafe: hex(20, "90"),
        entryPoint: hex(20, "a0"),
        paymaster: hex(20, "b0"),
        accountImplementation: hex(20, "c0"),
        bundlerUrl: "http://192.168.1.50:4337",
        dashboardUrl: "http://192.168.1.50:8080",
        members: [
            {
                name: "alpha",
                networkId: hex(32, "a1"),
                serverUrl: "http://192.168.1.50:4001",
                authAddress: hex(20, "d0"),
                governanceSigner: hex(20, "e0"),
                role: "founder",
                brand: { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" },
                scheme: "member-a"
            },
            {
                name: "beta",
                networkId: hex(32, "a2"),
                serverUrl: "http://192.168.1.50:4002",
                authAddress: hex(20, "d1"),
                governanceSigner: hex(20, "e1"),
                role: "candidate",
                brand: { accent: "#f5b400", onAccent: "#17201c", accentSoft: "#fdf1cc", accentInk: "#8a5a00" },
                scheme: "member-b"
            }
        ]
    }
}

/** member-a's pairing link. */
export const PAIRING_URL_A = "http://192.168.1.50:8080/stack.json#org=0&token=member-token-a"

/** What Setup stores after pairing with `PAIRING_URL_A`. */
export function fakePairing(): Pairing {
    return { stack: fakeStack(), memberServerToken: "member-token-a" }
}

type FetchResponse = { ok: boolean; status: number; text: () => Promise<string> }

/** Fetch stub serving `stack` at any `…/stack.json` and delegating the rest to `fallback`. */
export function withStackJson(
    fallback: (url: string, init?: { method?: string }) => Promise<FetchResponse> = async () => ({
        ok: false,
        status: 500,
        text: async () => ""
    }),
    stack: unknown = fakeStack()
): (url: string, init?: { method?: string }) => Promise<FetchResponse> {
    return (url, init) =>
        url.endsWith("/stack.json")
            ? Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(stack) })
            : fallback(url, init)
}

/** Every port throws by default, so a test only has to override the methods its screen actually calls. */
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

export interface BuildFlowsOptions {
    server?: Partial<MemberServerClient>
    link?: LinkClient
    config?: Partial<MemberConfig>
}

/**
 * Builds a real `MemberFlows` (per this app's own `createMemberFlows`) over fake link and server
 * ports, so a screen test exercises the same wiring `App.tsx` does rather than a hand-rolled stub
 * of the whole interface.
 */
export function buildFlows({ server, link, config }: BuildFlowsOptions = {}): MemberFlows {
    const ctx: MemberContext = {
        config: {
            networkId: hex(32, "a1"),
            displayName: business.branding.displayName,
            serverUrl: "http://192.168.1.50:4001",
            registry: { chainId: 31337, verifyingContract: hex(20, "10") },
            memberServerToken: "member-token-a",
            ...config
        },
        link: link ?? createFakeLinkClient({}),
        server: createFakeServer(server),
        policy: business.policy,
        hooks: business.hooks
    }
    return createMemberFlows(ctx)
}
