jest.mock("../adapters/device-key", () => ({
    createDeviceKey: jest.fn(async () => mockDeviceKey),
    replaceDeviceKeys: jest.fn(async () => mockDeviceKey),
    eraseDeviceKey: jest.fn()
}))

// jest.mock's factory may only reference variables prefixed `mock` - see src/__tests__/link.test.ts.
// Stateful, so a test can see what a recovery leaves behind.
const mockStoreEntries = new Map<string, string>()

jest.mock("../adapters/store", () => ({
    createDeviceStore: () => ({
        get: async (key: string) => mockStoreEntries.get(key) ?? null,
        set: async (key: string, value: string) => {
            mockStoreEntries.set(key, value)
        },
        delete: async (key: string) => {
            mockStoreEntries.delete(key)
        },
        list: async () => [...mockStoreEntries.keys()]
    }),
    eraseDeviceStore: jest.fn()
}))

jest.mock("../adapters/prover", () => ({
    createProver: jest.fn(async () => {
        throw new Error("credential-abi.json has no abi.parameters — re-run scripts/sync-assets.sh")
    })
}))

jest.mock("../config", () => ({
    readStackConfig: jest.fn(async () => null),
    writeStackConfig: jest.fn(),
    resolveStackDescriptor: jest.fn()
}))

let mockLinkOptions: LinkSubscriptionOptions | null = null

// The ports App hands the real service, so a test can report progress or ask for a review the way
// a running handler would.
let mockPorts: UserAppPorts | null = null

// Each service App builds, in build order, with a spy on its reconciliation.
const mockReconciles: jest.SpyInstance[] = []
// When set, a service built from then on reports this many removed credentials instead of reconciling.
let mockRemovedCount: number | null = null
// When set, a service built from then on fails its reconciliation with this error.
let mockReconcileError: Error | null = null

jest.mock("@coordination-network/user-app-core", () => {
    const actual = jest.requireActual("@coordination-network/user-app-core")
    return {
        ...actual,
        createUserAppService: (ports: UserAppPorts) => {
            mockPorts = ports
            const service = actual.createUserAppService(ports)
            const reconcile = jest.spyOn(service, "removeUnboundCredentials")
            if (mockRemovedCount !== null) reconcile.mockResolvedValue(mockRemovedCount)
            if (mockReconcileError !== null) reconcile.mockRejectedValue(mockReconcileError)
            mockReconciles.push(reconcile)
            return service
        }
    }
})

jest.mock("../link", () => ({
    createLinkSubscription: jest.fn((options: LinkSubscriptionOptions) => {
        mockLinkOptions = options
        return { remove: jest.fn() }
    })
}))

import { act } from "react-test-renderer"
import type { ReactTestRenderer } from "react-test-renderer"
import type { DecodedLinkRequest, LinkOp } from "@coordination-network/user-app-link"
import { AppBar, Sheet } from "@coordination-network/app-ui"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import { sec1ToJwk } from "@coordination-network/expo-identity-keystore"
import { eddsaPeerPointBytes } from "@coordination-network/identity"
import {
    DEVICE_SECRET_KEY,
    type DeviceKey,
    type PresentationReview,
    type UserAppPorts
} from "@coordination-network/user-app-core"
import { createDeviceKey, eraseDeviceKey, replaceDeviceKeys } from "../adapters/device-key"
import { eraseDeviceStore } from "../adapters/store"
import { createProver } from "../adapters/prover"
import App from "../App"
import { createLinkSubscription, type LinkSubscriptionOptions } from "../link"

const DEVICE_SECRET = `0x${"ab".repeat(32)}`

// Reconciliation reads the signing key's public key, so it has to be a real point; nothing these
// tests drive asks the keys for anything else.
const mockDeviceKey: DeviceKey = {
    getPublicKeyJwk: async () => sec1ToJwk(eddsaPeerPointBytes()),
    signerFor: () => {
        throw new Error("App tests never sign")
    },
    ecdh: async () => {
        throw new Error("App tests never run ECDH")
    },
    getSecurityLevel: async () => "SOFTWARE",
    getAttestationChain: async () => []
}

function onboard(): void {
    mockStoreEntries.set(DEVICE_SECRET_KEY, DEVICE_SECRET)
}

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

const registrationRequest: DecodedLinkRequest = {
    id: "req-1",
    version: "v1",
    caller: { name: "Member App", scheme: "member-a" },
    callback: "member-a://v1/response",
    op: "registration.sign",
    params: { chainId: 31_337, verifyingContract: `0x${"cc".repeat(20)}` }
}

const issuanceRequest: DecodedLinkRequest = {
    id: "req-2",
    version: "v1",
    caller: { name: "Member App", scheme: "member-a" },
    callback: "member-a://v1/response",
    op: "credential.issue",
    params: {
        issuerNetworkId: `0x${"11".repeat(32)}`,
        approvalScope: { programme: "standard-access", country: "ZZZ" },
        challengeUrl: "https://member.example/v1/challenge",
        credentialsUrl: "https://member.example/v1/credentials",
        issuersUrl: "https://member.example/v1/issuers",
        revocationsUrl: "https://member.example/v1/revocations/snapshot"
    }
}

const presentationRequest: DecodedLinkRequest = {
    id: "req-3",
    version: "v1",
    caller: { name: "Member App", scheme: "member-a" },
    callback: "member-a://v1/response",
    op: "presentation.create",
    params: {
        requestId: "pres-1",
        challenge: `0x${"0d".repeat(31)}`,
        audience: "urn:cn:network:verifier",
        currentTime: 0,
        programme: "standard-access",
        country: "ZZZ",
        issuersUrl: "https://member.example/v1/issuers",
        responseUrl: "https://member.example/v1/verify"
    }
}

beforeEach(() => {
    mockLinkOptions = null
    mockPorts = null
    mockStoreEntries.clear()
    mockReconciles.length = 0
    mockRemovedCount = null
    mockReconcileError = null
    jest.mocked(eraseDeviceKey).mockClear()
    jest.mocked(eraseDeviceStore).mockClear()
    jest.mocked(createDeviceKey).mockClear()
    jest.mocked(replaceDeviceKeys).mockClear()
    jest.mocked(createLinkSubscription).mockClear()
})

/** Approves a request and reports it working, the way link.ts does once consent resolves. */
async function approve(tree: ReactTestRenderer, request: DecodedLinkRequest): Promise<void> {
    act(() => {
        void mockLinkOptions?.consent(request)
    })
    act(() => {
        tree.root.findByProps({ testID: "consent-approve" }).props.onPress()
    })
    act(() => {
        mockLinkOptions?.onWorking?.(request.op as LinkOp)
    })
}

describe("App's landing tab", () => {
    beforeEach(() => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
    })

    it("opens on Identity while there is no identity, since nothing else works without one", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(allText(tree)).toContain("Create your identity")
        } finally {
            act(() => tree.unmount())
        }
    })

    it("opens on Credentials once an identity exists", async () => {
        onboard()
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(allText(tree)).toContain("An org issues one after you register.")
        } finally {
            act(() => tree.unmount())
        }
    })
})

describe("App boot", () => {
    it("shows an error state instead of spinning forever when a boot port rejects", async () => {
        const tree = await renderScreen(<App />)
        await flush()

        const text = allText(tree)
        expect(text).toContain("The app could not start")
        expect(text).toContain("credential-abi.json has no abi.parameters — re-run scripts/sync-assets.sh")
        // The band names this app even on the error screen - a deep link can jump here at any moment.
        expect(text).toContain("User wallet")
    })
})

describe("App's device security floor", () => {
    it("hands the service a SOFTWARE floor under __DEV__", async () => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(__DEV__).toBe(true)
            expect(mockPorts?.minimumDeviceSecurityLevel).toBe("SOFTWARE")
        } finally {
            act(() => tree.unmount())
        }
    })

    it("hands the service a TRUSTED_ENVIRONMENT floor in a release build", async () => {
        const g = globalThis as { __DEV__?: boolean }
        const original = g.__DEV__
        g.__DEV__ = false
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
        try {
            const tree = await renderScreen(<App />)
            try {
                await flush()

                expect(mockPorts?.minimumDeviceSecurityLevel).toBe("TRUSTED_ENVIRONMENT")
            } finally {
                act(() => tree.unmount())
            }
        } finally {
            g.__DEV__ = original
        }
    })
})

describe("App boot, when the device keys cannot be created", () => {
    it.each([
        ["ERR_NO_SECURE_LOCK_SCREEN", "Set a screen lock to use this wallet"],
        ["ERR_UNSUPPORTED_PLATFORM", "This wallet needs Android 12 or newer"]
    ])("says what to do about %s", async (code, message) => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
        jest.mocked(createDeviceKey).mockRejectedValueOnce(Object.assign(new Error(code), { code }))
        const tree = await renderScreen(<App />)
        await flush()

        const text = allText(tree)
        expect(text).toContain("The app could not start")
        expect(text).toContain(message)
    })
})

const clearedNotice =
    "Credentials on this phone were cleared. Your registration is kept. Ask your organisation to re-issue them."

describe("App's boot reconciliation of credentials with the device keys", () => {
    beforeEach(() => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
    })

    it("removes credentials bound to keys that were replaced, and says so", async () => {
        onboard()
        mockRemovedCount = 1
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(mockReconciles[0]).toHaveBeenCalledTimes(1)
            expect(allText(tree)).toContain(clearedNotice)

            act(() => {
                tree.root.findByProps({ testID: "notice-dismiss" }).props.onPress()
            })
            expect(allText(tree)).not.toContain(clearedNotice)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("reconciles at every boot, and says nothing when nothing was removed", async () => {
        onboard()
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(mockReconciles[0]).toHaveBeenCalledTimes(1)
            await expect(mockReconciles[0].mock.results[0].value).resolves.toBe(0)
            expect(allText(tree)).not.toContain(clearedNotice)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("still reaches the credentials tab when reconciliation fails, warning without the failure's contents", async () => {
        onboard()
        mockReconcileError = new Error("credential 0xsecret-id is corrupt")
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(allText(tree)).toContain("An org issues one after you register.")
            expect(allText(tree)).not.toContain("The app could not start")
            expect(warn).toHaveBeenCalledTimes(1)
            expect(JSON.stringify(warn.mock.calls)).not.toContain("0xsecret-id")
        } finally {
            act(() => tree.unmount())
            warn.mockRestore()
        }
    })

    it("has nothing to reconcile before an identity exists", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            expect(mockReconciles[0]).not.toHaveBeenCalled()
            expect(allText(tree)).not.toContain(clearedNotice)
        } finally {
            act(() => tree.unmount())
        }
    })
})

describe("App's recovery from an invalidated key", () => {
    beforeEach(() => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
        onboard()
    })

    /** Boots onboarded and hands back the device key's `onInvalidated`, as the adapter would call it. */
    async function booted(): Promise<{ tree: ReactTestRenderer; onInvalidated: () => void }> {
        const tree = await renderScreen(<App />)
        await flush()
        return { tree, onInvalidated: jest.mocked(createDeviceKey).mock.calls[0][0].onInvalidated }
    }

    it("replaces only the device keys, keeps the device secret, and reconciles on a rebuilt service", async () => {
        const { tree, onInvalidated } = await booted()
        try {
            mockRemovedCount = 1

            await act(async () => {
                onInvalidated()
                await flush()
            })

            expect(replaceDeviceKeys).toHaveBeenCalledTimes(1)
            expect(eraseDeviceKey).not.toHaveBeenCalled()
            expect(eraseDeviceStore).not.toHaveBeenCalled()
            expect(mockStoreEntries.get(DEVICE_SECRET_KEY)).toBe(DEVICE_SECRET)
            expect(await mockPorts?.store.get(DEVICE_SECRET_KEY)).toBe(DEVICE_SECRET)
            expect(mockReconciles).toHaveLength(2)
            expect(mockReconciles[1]).toHaveBeenCalledTimes(1)
            expect(allText(tree)).toContain(clearedNotice)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("says nothing when the rebuilt service had nothing to remove", async () => {
        const { tree, onInvalidated } = await booted()
        try {
            await act(async () => {
                onInvalidated()
                await flush()
            })

            expect(mockReconciles[1]).toHaveBeenCalledTimes(1)
            expect(allText(tree)).not.toContain(clearedNotice)
            expect(allText(tree)).not.toContain("The app could not start")
        } finally {
            act(() => tree.unmount())
        }
    })

    it("attaches the rebuilt service when its reconciliation fails", async () => {
        const { tree, onInvalidated } = await booted()
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
        try {
            mockReconcileError = new Error("credential 0xsecret-id is corrupt")

            await act(async () => {
                onInvalidated()
                await flush()
            })

            expect(mockReconciles).toHaveLength(2)
            expect(allText(tree)).not.toContain("The app could not start")
            expect(allText(tree)).toContain("An org issues one after you register.")
            expect(warn).toHaveBeenCalledTimes(1)
            expect(JSON.stringify(warn.mock.calls)).not.toContain("0xsecret-id")
        } finally {
            act(() => tree.unmount())
            warn.mockRestore()
        }
    })

    it("shows the boot error, not an unhandled rejection, when the keys cannot be replaced", async () => {
        const unhandled = jest.fn()
        process.on("unhandledRejection", unhandled)
        const { tree, onInvalidated } = await booted()
        try {
            jest.mocked(replaceDeviceKeys).mockRejectedValueOnce(
                Object.assign(new Error("ERR_NO_SECURE_LOCK_SCREEN"), { code: "ERR_NO_SECURE_LOCK_SCREEN" })
            )

            await act(async () => {
                onInvalidated()
                await flush()
            })

            const text = allText(tree)
            expect(text).toContain("The app could not start")
            expect(text).toContain("Set a screen lock to use this wallet")
            expect(unhandled).not.toHaveBeenCalled()
        } finally {
            process.off("unhandledRejection", unhandled)
            act(() => tree.unmount())
        }
    })

    it("runs one recovery for invalidations that arrive while it is running, and a new one after", async () => {
        const { tree, onInvalidated } = await booted()
        try {
            let release!: (deviceKey: DeviceKey) => void
            jest.mocked(replaceDeviceKeys).mockImplementationOnce(
                () => new Promise<DeviceKey>((resolve) => (release = resolve))
            )

            await act(async () => {
                onInvalidated()
                onInvalidated()
                await flush()
                onInvalidated()
                release(mockDeviceKey)
                await flush()
            })

            expect(replaceDeviceKeys).toHaveBeenCalledTimes(1)
            expect(mockReconciles).toHaveLength(2)

            await act(async () => {
                onInvalidated()
                await flush()
            })

            expect(replaceDeviceKeys).toHaveBeenCalledTimes(2)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("detaches the old service's links before touching the keys, and attaches the rebuilt one at the end", async () => {
        const { tree, onInvalidated } = await booted()
        try {
            const oldLinks = jest.mocked(createLinkSubscription).mock.results[0].value
            const oldHandlers = mockLinkOptions?.handlers
            let release!: (deviceKey: DeviceKey) => void
            jest.mocked(replaceDeviceKeys).mockImplementationOnce(
                () => new Promise<DeviceKey>((resolve) => (release = resolve))
            )

            await act(async () => {
                onInvalidated()
                await flush()
            })

            // Removed before the keys are touched, not on the next render: a link already queued
            // must not start on the old service while its keys are being deleted.
            expect(jest.mocked(oldLinks.remove).mock.invocationCallOrder[0]).toBeLessThan(
                jest.mocked(replaceDeviceKeys).mock.invocationCallOrder[0]
            )
            expect(createLinkSubscription).toHaveBeenCalledTimes(1)

            await act(async () => {
                release(mockDeviceKey)
                await flush()
            })

            expect(createLinkSubscription).toHaveBeenCalledTimes(2)
            expect(mockLinkOptions?.handlers).not.toBe(oldHandlers)
        } finally {
            act(() => tree.unmount())
        }
    })
})

describe("App's identity band", () => {
    beforeEach(() => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
    })

    it("shows the wallet band above every tab", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            for (const key of ["credentials", "identity", "config", "settings"]) {
                act(() => {
                    tree.root.findByProps({ testID: `tab-${key}` }).props.onPress()
                })
                expect(tree.root.findAllByType(AppBar).length).toBeGreaterThan(0)
            }
        } finally {
            act(() => tree.unmount())
        }
    })

    it("shows the wallet band again, compact, above the consent sheet", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            act(() => {
                void mockLinkOptions?.consent(registrationRequest)
            })

            // One band above the screen, one capping the sheet - see App.tsx's two AppBar/Sheet uses.
            expect(tree.root.findAllByType(AppBar)).toHaveLength(2)
        } finally {
            act(() => tree.unmount())
        }
    })
})

describe("App's second gate, on a presentation", () => {
    beforeEach(() => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
    })

    const proofReview: PresentationReview = {
        kind: "proof",
        verifier: "urn:cn:network:verifier",
        programme: "standard-access",
        country: "ZZZ",
        issuerNetworkId: `0x${"11".repeat(32)}`
    }

    it("shows what the verifier would learn before the proof is built, and goes on to prove on Share", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()
            await approve(tree, presentationRequest)

            let answer: Promise<boolean> | undefined
            act(() => {
                answer = mockPorts?.review(proofReview)
            })

            expect(allText(tree)).toContain("Ready to prove")

            act(() => {
                tree.root.findByProps({ testID: "share-proof" }).props.onPress()
            })

            await expect(answer).resolves.toBe(true)
            // The handler runs on underneath, so the sheet goes back to the working body.
            expect(allText(tree)).toContain("Proving")
        } finally {
            act(() => tree.unmount())
        }
    })

    it("refuses on Don't share", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()
            await approve(tree, presentationRequest)

            let answer: Promise<boolean> | undefined
            act(() => {
                answer = mockPorts?.review(proofReview)
            })
            act(() => {
                tree.root.findByProps({ testID: "share-refuse" }).props.onPress()
            })

            await expect(answer).resolves.toBe(false)
        } finally {
            act(() => tree.unmount())
        }
    })

    // The same gate, on the refusal - but it reports rather than asks, and resolves true either
    // way, because only a true reaches the verifier as CREDENTIAL_REVOKED and gives its check a
    // verdict. A false leaves the request unresolved until it expires.
    it("reports a revoked credential and tells the verifier on the one action it offers", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()
            await approve(tree, presentationRequest)

            let answer: Promise<boolean> | undefined
            act(() => {
                answer = mockPorts?.review({ ...proofReview, kind: "revoked" })
            })

            expect(allText(tree)).toContain("Credential revoked")
            expect(tree.root.findAllByProps({ testID: "share-refuse" }, { deep: false })).toHaveLength(0)

            act(() => {
                tree.root.findByProps({ testID: "revoked-ack" }).props.onPress()
            })

            await expect(answer).resolves.toBe(true)
        } finally {
            act(() => tree.unmount())
        }
    })
})

describe("App consent and working state", () => {
    beforeEach(() => {
        jest.mocked(createProver).mockResolvedValueOnce({} as never)
    })

    it("keeps one Sheet mounted from consent to working, showing the op's label, once approved", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            act(() => {
                void mockLinkOptions?.consent(registrationRequest)
            })
            // Consent and Working are each just the body of App's one `Sheet` now (see App.tsx) -
            // capturing it here and comparing by reference below catches a regression back to each
            // owning its own `Sheet`, which would dismiss and re-present the native modal on Approve.
            const sheetBeforeApprove = tree.root.findByType(Sheet)

            act(() => {
                tree.root.findByProps({ testID: "consent-approve" }).props.onPress()
            })
            act(() => {
                mockLinkOptions?.onWorking?.("registration.sign")
            })

            expect(tree.root.findByType(Sheet)).toBe(sheetBeforeApprove)

            const text = allText(tree)
            expect(text).toContain("Sharing your identity")
            expect(text).toContain("Keep this app open.")
        } finally {
            act(() => tree.unmount())
        }
    })

    it("moves the working body's step list on as the handler reports progress", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            act(() => {
                void mockLinkOptions?.consent(issuanceRequest)
            })
            act(() => {
                tree.root.findByProps({ testID: "consent-approve" }).props.onPress()
            })
            act(() => {
                mockLinkOptions?.onWorking?.("credential.issue")
            })

            expect(tree.root.findAllByProps({ testID: "step-binding-spinner" })).toHaveLength(0)

            act(() => {
                mockPorts?.progress("credential.issue", "Binding to this phone")
            })

            const text = allText(tree)
            expect(text).toContain("Storing a credential")
            expect(text).toContain("Binding the credential")
            expect(tree.root.findAllByProps({ testID: "step-binding-spinner" }).length).toBeGreaterThan(0)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("closes the sheet once onWorking(null) arrives", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            act(() => {
                void mockLinkOptions?.consent(registrationRequest)
            })
            act(() => {
                tree.root.findByProps({ testID: "consent-approve" }).props.onPress()
            })
            act(() => {
                mockLinkOptions?.onWorking?.("registration.sign")
            })
            expect(allText(tree)).toContain("Sharing your identity")

            act(() => {
                mockLinkOptions?.onWorking?.(null)
            })

            expect(allText(tree)).not.toContain("Sharing your identity")
            expect(tree.root.findAllByProps({ testID: "consent-approve" })).toHaveLength(0)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("closes the sheet immediately on deny", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            act(() => {
                void mockLinkOptions?.consent(registrationRequest)
            })
            // `findAllByProps` defaults to a deep search, matching testID at every layer a
            // Pressable forwards it through - `{ deep: false }` stops at the outermost Button.
            expect(tree.root.findAllByProps({ testID: "consent-deny" }, { deep: false })).toHaveLength(1)

            act(() => {
                tree.root.findByProps({ testID: "consent-deny" }).props.onPress()
            })

            expect(tree.root.findAllByProps({ testID: "consent-deny" }, { deep: false })).toHaveLength(0)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("denies consent and closes the sheet when the consent phase's own onRequestClose fires", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            let consentPromise: Promise<boolean> | undefined
            act(() => {
                consentPromise = mockLinkOptions?.consent(registrationRequest)
            })
            const sheet = tree.root.findByType(Sheet)
            expect(typeof sheet.props.onRequestClose).toBe("function")

            act(() => {
                sheet.props.onRequestClose()
            })

            await expect(consentPromise).resolves.toBe(false)
            expect(tree.root.findAllByType(Sheet)).toHaveLength(0)
        } finally {
            act(() => tree.unmount())
        }
    })

    it("cannot be dismissed while a request is working: no onRequestClose, and the backdrop press is a no-op", async () => {
        const tree = await renderScreen(<App />)
        try {
            await flush()

            act(() => {
                void mockLinkOptions?.consent(registrationRequest)
            })
            act(() => {
                tree.root.findByProps({ testID: "consent-approve" }).props.onPress()
            })
            act(() => {
                mockLinkOptions?.onWorking?.("registration.sign")
            })

            const sheet = tree.root.findByType(Sheet)
            expect(sheet.props.onRequestClose).toBeUndefined()

            // The backdrop is Sheet's outer Pressable, identified by the style only it carries
            // (its `onPress` prop key, present but undefined here, rules out the plain host View
            // beneath it - see Sheet.tsx).
            const backdrop = tree.root.find(
                (node) =>
                    typeof node.type !== "string" &&
                    "onPress" in node.props &&
                    node.props.style?.justifyContent === "flex-end"
            )
            act(() => {
                backdrop.props.onPress?.()
            })

            expect(allText(tree)).toContain("Sharing your identity")
            expect(tree.root.findAllByType(Sheet)).toHaveLength(1)

            act(() => {
                mockLinkOptions?.onWorking?.(null)
            })

            expect(allText(tree)).not.toContain("Sharing your identity")
        } finally {
            act(() => tree.unmount())
        }
    })
})
