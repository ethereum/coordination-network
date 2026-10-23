import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { decodeRequest } from "@coordination-network/user-app-link"
import { createMemberLinkClient } from "../src/link"

// jest.mock's factory can't close over plain out-of-scope variables - only ones named `mock*`
// (case-insensitive) are exempt from that check, hence the prefix on all three below. Each is
// typed via jest.fn's own generic rather than named parameters, since the default implementation
// doesn't need to look at its arguments.
const mockAddEventListener = jest.fn<
    (type: "url", listener: (event: { url: string }) => void) => { remove: () => void }
>(() => ({ remove: jest.fn() }))
const mockOpenURL = jest.fn<(url: string) => Promise<true>>(() => Promise.resolve(true))
const mockCreateURL = jest.fn((path: string) => `member-a://${path}`)

jest.mock("expo-linking", () => ({
    addEventListener: (type: "url", listener: (event: { url: string }) => void) => mockAddEventListener(type, listener),
    openURL: (url: string) => mockOpenURL(url),
    createURL: (path: string) => mockCreateURL(path)
}))

describe("createMemberLinkClient", () => {
    // Neither test below ever settles its `client.request(...)` - fake timers keep the
    // link client's own 120s timeout from leaving a real timer running past the test.
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    it("opens a request built for the user app's own scheme, with this app's callback", async () => {
        const client = createMemberLinkClient("Member A")
        // `Linking.createURL` uses *this* app's scheme (set via `app.config.ts`'s `EXPO_PUBLIC_MEMBER_ID`).
        expect(mockCreateURL).toHaveBeenCalledWith("v1/response")

        // Never resolves in this test - only the wiring up to `openUrl` matters here.
        void client.request("registration.sign", { chainId: 31337, verifyingContract: `0x${"10".repeat(20)}` })

        expect(mockOpenURL).toHaveBeenCalledTimes(1)
        const requestUrl = mockOpenURL.mock.calls[0][0]
        // No `scheme` override was passed to `createLinkClient`, so the *outgoing* request opens
        // the user app's own default scheme - only the payload's `caller.scheme` names this app.
        expect(requestUrl.startsWith("userapp://")).toBe(true)
        expect(decodeRequest(requestUrl).caller).toEqual({ name: "Member A", scheme: "member-a" })
    })

    // What this app is responsible for is the wiring: that expo-linking's three functions reach
    // `createLinkClient` in the right places. The client's own lifecycle - settling on a matching
    // response, unsubscribing exactly once, timing out - is covered against the client itself in
    // `packages/user-app-link/tests/client.test.ts`, and is not re-tested through a mock here.
    it("passes expo-linking's addEventListener through as the client's onUrl subscription", () => {
        const remove = jest.fn()
        mockAddEventListener.mockReturnValue({ remove })

        const client = createMemberLinkClient("Member A")
        void client.request("registration.sign", { chainId: 31337, verifyingContract: `0x${"10".repeat(20)}` })

        expect(mockAddEventListener).toHaveBeenCalledWith("url", expect.any(Function))
        expect(mockCreateURL).toHaveBeenCalledWith("v1/response")
    })
})
