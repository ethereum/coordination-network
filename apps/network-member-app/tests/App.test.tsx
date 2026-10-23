import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { View } from "react-native"
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context"
import { AppBar, BRANDS, ThemeProvider } from "@coordination-network/app-ui"
import { allText, changeText, press, renderScreen } from "@coordination-network/app-ui/testing"
import { act } from "react-test-renderer"
import App from "../src/App"
import { brand } from "../src/business"
import { STORAGE_KEY, clearStoredPairing, storePairing } from "../src/config"
import {
    PAIRING_URL_A,
    createFakeLinkClient as mockCreateFakeLinkClient,
    fakePairing,
    fakeStack,
    hex as mockHex,
    withStackJson
} from "./support"

// Same manual mock as tests/link.test.ts: expo-linking has no default jest-expo mock, and App
// builds a `LinkClient` off it as soon as a stack is loaded.
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

// The real LinkClient drives a deep-link round trip this test has no need to simulate - only
// the tab-switching test below (which presses "run-register") reaches into it.
jest.mock("../src/link", () => ({
    createMemberLinkClient: () =>
        mockCreateFakeLinkClient({
            "registration.sign": async () => ({
                request: {
                    version: "v1" as const,
                    networkId: mockHex(32, "11"),
                    schemeId: 1 as const,
                    metaStealthAddress: mockHex(66, "22"),
                    chainId: 31337,
                    verifyingContract: mockHex(20, "10"),
                    signature: mockHex(65, "55")
                },
                securityLevel: "SOFTWARE" as const
            })
        })
}))

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("App", () => {
    const originalFetch = global.fetch

    beforeEach(async () => {
        await storePairing(fakePairing())
        // Real `createMemberServerClient` wiring, so every screen's `membershipStatus()` needs
        // a fetch response rather than a fake port - this app has no seam to inject one instead.
        // Serves `stack.json` for the tests that pair again.
        global.fetch = jest.fn(withStackJson()) as never
    })

    afterEach(async () => {
        global.fetch = originalFetch
        await clearStoredPairing()
    })

    it("keeps a QR check running across tabs and records its result in Activity", async () => {
        let completed = false
        let cancellations = 0
        let creations = 0
        const now = Math.floor(Date.now() / 1000)
        const request = {
            requestId: "qr-request",
            challenge: mockHex(31, "aa"),
            audience: fakeStack().members[0].networkId,
            currentTime: now,
            programme: "demo-programme",
            country: "ZZZ",
            expiresAt: now + 300
        }
        global.fetch = jest.fn(
            withStackJson(async (url, init) => {
                let body: unknown
                let status = 200
                if (url.endsWith("/v1/presentation-requests") && init?.method === "POST") {
                    creations++
                    status = 201
                    body = request
                } else if (url.endsWith("/cancel")) {
                    cancellations++
                    body = { status: "cancelled" }
                } else if (url.endsWith("/v1/presentation-requests/qr-request")) {
                    body = completed
                        ? {
                              status: "completed",
                              verification: { ...request, verificationId: "qr-result", ok: true, verifiedAt: now }
                          }
                        : { status: "pending" }
                    if (completed) {
                        const record = (body as { verification: Record<string, unknown> }).verification
                        delete record.expiresAt
                    }
                } else {
                    status = 500
                    body = {}
                }
                return { ok: status < 400, status, text: async () => JSON.stringify(body) }
            })
        ) as never
        const tree = await renderScreen(<App />)
        await flush()
        await flush()
        const click = (testID: string) =>
            act(async () => {
                tree.root.findByProps({ testID }).props.onPress()
            })
        try {
            await click("tab-verify")
            await click("verify-another-phone")
            await click("create-presentation-qr")
            await click("tab-activity")
            expect(cancellations).toBe(0)
            completed = true
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 1600))
            })
            expect(allText(tree)).toContain("verified a presentation")
            await click("tab-verify")
            expect(allText(tree)).toContain("Eligible")
            expect(creations).toBe(1)
        } finally {
            await act(async () => tree.unmount())
        }
    })

    it("lands on User, with all four tabs in order", async () => {
        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        // `Pressable` forwards its own props down through the host `View` it renders, so matching
        // by `accessibilityRole` alone over-counts; `onPress` only ever lands on the real button.
        const order = tree.root
            .findAll((node) => node.props.accessibilityRole === "tab" && typeof node.props.onPress === "function")
            .map((tab) => tab.props.accessibilityLabel)
        expect(order).toEqual(["User", "Verify", "Activity", "Settings"])
        expect(allText(tree)).toContain("Register a wallet")
        // jest.setup.js defaults the build to member-a.
        expect(allText(tree)).toContain("Member A")
    })

    it("paints the band with this member's own accent - blue for member-a, yellow for member-b", async () => {
        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        expect(tree.root.findByType(AppBar).findByType(View).props.style.backgroundColor).toBe(BRANDS.blue.accent)

        // `branding.ts` picks its colours from `EXPO_PUBLIC_MEMBER_ID` at module load, the same way
        // tests/branding.test.ts loads it fresh for the other member; this checks that colour
        // actually reaches a rendered band rather than just pinning the value.
        let brandB!: typeof brand
        jest.isolateModules(() => {
            process.env.EXPO_PUBLIC_MEMBER_ID = "member-b"
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            brandB = require("../src/business").brand
        })
        process.env.EXPO_PUBLIC_MEMBER_ID = "member-a"

        const bandB = await renderScreen(
            <ThemeProvider brand={brandB}>
                <AppBar name="Member B" />
            </ThemeProvider>
        )
        expect(bandB.root.findByType(AppBar).findByType(View).props.style.backgroundColor).toBe(BRANDS.yellow.accent)
    })

    it("seeds SafeAreaProvider with the window's initial metrics", async () => {
        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        expect(tree.root.findByType(SafeAreaProvider).props.initialMetrics).toBe(initialWindowMetrics)
    })

    it("switches to Settings, and Change stack there returns to Setup with the User screen reset", async () => {
        global.fetch = jest.fn(
            withStackJson(async (url: string, init?: { method?: string }) => {
                if (init?.method === "POST" && url.endsWith("/v1/registrations")) {
                    return {
                        ok: true,
                        status: 201,
                        text: async () => JSON.stringify({ status: "submitted", txHash: mockHex(32, "aa") })
                    }
                }
                return { ok: false, status: 500, text: async () => "" }
            })
        ) as never

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        await act(async () => {
            await tree.root.findByProps({ testID: "run-register" }).props.onPress()
        })
        await flush()
        // Registered: the Register button is gone, replaced by Issue.
        expect(tree.root.findAllByProps({ testID: "run-register" }, { deep: false })).toHaveLength(0)

        await act(async () => {
            tree.root.findByProps({ testID: "tab-settings" }).props.onPress()
        })
        await flush()

        expect(allText(tree)).toContain("Founding org")

        await act(async () => {
            await tree.root.findByProps({ testID: "change-stack" }).props.onPress()
        })
        await flush()

        expect(allText(tree)).toContain("Connect")

        // Accept a stack again to get back to the main view.
        await changeText(tree, 0, PAIRING_URL_A)
        await press(tree, 1) // scan-stack (0) precedes save-pasted (1) in render order
        await flush()

        // `tab` itself survived the round trip (still "settings" from before) - switch back to User.
        await act(async () => {
            tree.root.findByProps({ testID: "tab-user" }).props.onPress()
        })
        await flush()

        // Back on User: idle, not carrying the previous stack's registration.
        expect(tree.root.findAllByProps({ testID: "run-register" }, { deep: false })).toHaveLength(1)
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
        expect(allText(tree)).not.toContain("Gas paid by the Semaphore paymaster")
    })

    it("ignores an in-flight registration's outcome once Change stack has moved to a new one", async () => {
        let resolveRegistration!: (value: { ok: boolean; status: number; text: () => Promise<string> }) => void
        global.fetch = jest.fn(
            withStackJson((url: string, init?: { method?: string }) => {
                if (init?.method === "POST" && url.endsWith("/v1/registrations")) {
                    return new Promise((resolve) => {
                        resolveRegistration = resolve
                    })
                }
                return Promise.resolve({ ok: false, status: 500, text: async () => "" })
            })
        ) as never

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        await act(async () => {
            tree.root.findByProps({ testID: "run-register" }).props.onPress()
        })
        await flush()
        // Still in flight: no Issue button yet, since the registration hasn't settled.
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)

        // Change stack while that registration is still pending.
        await act(async () => {
            tree.root.findByProps({ testID: "tab-settings" }).props.onPress()
        })
        await flush()
        await act(async () => {
            await tree.root.findByProps({ testID: "change-stack" }).props.onPress()
        })
        await flush()

        // Provide a new stack.
        await changeText(tree, 0, PAIRING_URL_A)
        await press(tree, 1) // scan-stack (0) precedes save-pasted (1) in render order
        await flush()

        // Now let the old stack's registration settle.
        await act(async () => {
            resolveRegistration({
                ok: true,
                status: 201,
                text: async () => JSON.stringify({ status: "submitted", txHash: mockHex(32, "aa") })
            })
            await flush()
        })

        // `tab` survived the round trip (still "settings") - switch back to User.
        await act(async () => {
            tree.root.findByProps({ testID: "tab-user" }).props.onPress()
        })
        await flush()

        // The new stack's User screen is idle, not carrying the old stack's outcome.
        const [button] = tree.root.findAllByProps({ testID: "run-register" }, { deep: false })
        expect(button).toBeDefined()
        expect(button.props.loading).toBe(false)
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
        expect(allText(tree)).not.toContain("Gas paid by the Semaphore paymaster")
    })

    it("clears a stored stack that no longer parses and shows the parse error on Setup", async () => {
        await AsyncStorage.setItem(STORAGE_KEY, "not json")

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        expect(allText(tree)).toContain("Connect")
        expect(allText(tree)).toContain("that's not valid JSON")
        expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it("clears a stored stack that is schema-valid but has no member for this app, showing the error on Setup", async () => {
        const stack = fakeStack()
        stack.members = []
        await storePairing({ ...fakePairing(), stack })

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        expect(allText(tree)).toContain("Connect")
        expect(allText(tree)).toContain("this stack has no member for member-a")
        expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it("sends an install set up before #285 back to Setup, clearing the stack it stored with every org's token", async () => {
        const stale = fakeStack() as unknown as { members: Record<string, unknown>[] }
        stale.members[0].memberServerToken = "member-token-a"
        stale.members[1].memberServerToken = "member-token-b"
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stale))

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        expect(allText(tree)).toContain("Connect")
        expect(allText(tree)).toContain("this app was set up for an older stack - scan this org's pairing QR again")
        expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it("clears the boot error once a valid stack is accepted, so a later Change stack doesn't show it again", async () => {
        await AsyncStorage.setItem(STORAGE_KEY, "not json")

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        expect(allText(tree)).toContain("that's not valid JSON")

        await changeText(tree, 0, PAIRING_URL_A)
        await press(tree, 1) // scan-stack (0) precedes save-pasted (1) in render order
        await flush()

        expect(allText(tree)).toContain("Register a wallet")

        await act(async () => {
            tree.root.findByProps({ testID: "tab-settings" }).props.onPress()
        })
        await flush()
        await act(async () => {
            await tree.root.findByProps({ testID: "change-stack" }).props.onPress()
        })
        await flush()

        expect(allText(tree)).not.toContain("that's not valid JSON")
    })

    it("waits for a stored stack to actually clear before booting into Setup", async () => {
        await AsyncStorage.setItem(STORAGE_KEY, "not json")

        let resolveRemove!: () => void
        const removeSpy = jest.spyOn(AsyncStorage, "removeItem").mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveRemove = () => resolve(undefined)
                })
        )

        try {
            const tree = await renderScreen(<App />)
            await flush()

            // The clear hasn't resolved yet - if it were `void`d instead of awaited, booting would
            // already be done and Setup would be showing regardless.
            expect(allText(tree)).not.toContain("Connect")

            await act(async () => {
                resolveRemove()
                await flush()
            })

            expect(removeSpy).toHaveBeenCalledWith(STORAGE_KEY)
            expect(allText(tree)).toContain("Connect")
            expect(allText(tree)).toContain("that's not valid JSON")
        } finally {
            removeSpy.mockRestore()
        }
    })

    it("still shows the boot error when clearing the stored stack fails, with nothing left unhandled", async () => {
        await AsyncStorage.setItem(STORAGE_KEY, "not json")
        const removeSpy = jest.spyOn(AsyncStorage, "removeItem").mockRejectedValue(new Error("disk full"))
        const unhandled: unknown[] = []
        const onUnhandledRejection = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on("unhandledRejection", onUnhandledRejection)

        try {
            const tree = await renderScreen(<App />)
            await flush()
            await flush()

            expect(allText(tree)).toContain("Connect")
            expect(allText(tree)).toContain("that's not valid JSON")
            expect(unhandled).toEqual([])
        } finally {
            process.off("unhandledRejection", onUnhandledRejection)
            removeSpy.mockRestore()
        }
    })

    it("keeps a sponsored registration's outcome after a glance at another tab", async () => {
        global.fetch = jest.fn(async (url: string, init?: { method?: string }) => {
            if (init?.method === "POST" && url.endsWith("/v1/registrations")) {
                return {
                    ok: true,
                    status: 201,
                    text: async () =>
                        JSON.stringify({
                            status: "submitted",
                            txHash: mockHex(32, "aa"),
                            sponsorship: {
                                sender: mockHex(20, "01"),
                                senderBalanceBefore: "0",
                                senderBalanceAfter: "0",
                                userOpHash: mockHex(32, "02"),
                                bundleTxHash: mockHex(32, "03"),
                                actualGasCost: "1234567",
                                paymaster: mockHex(20, "04"),
                                paymasterDepositBefore: "1000000000000000000",
                                paymasterDepositAfter: "998765432100000000"
                            }
                        })
                }
            }
            return { ok: false, status: 500, text: async () => "" }
        }) as never

        const tree = await renderScreen(<App />)
        await flush()
        await flush()

        await act(async () => {
            await tree.root.findByProps({ testID: "run-register" }).props.onPress()
        })
        await flush()
        expect(allText(tree)).toContain("Gas paid by the Semaphore paymaster")

        await act(async () => {
            tree.root.findByProps({ testID: "tab-activity" }).props.onPress()
        })
        await flush()
        await act(async () => {
            tree.root.findByProps({ testID: "tab-user" }).props.onPress()
        })
        await flush()

        expect(allText(tree)).toContain("Gas paid by the Semaphore paymaster")
    })
})
