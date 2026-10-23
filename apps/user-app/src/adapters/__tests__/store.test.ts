// Fakes with real in-memory persistence, so routing between backends is actually observable —
// the auto-mocked native modules jest-expo ships return undefined from every call.
const mockSecureStore = new Map<string, string>()
const mockAsyncStorage = new Map<string, string>()
const mockWriteOrder: string[] = []
const mockEraseOrder: string[] = []
let mockFailStoreKeyWrites = 0

jest.mock("expo-secure-store", () => ({
    getItemAsync: async (key: string) => mockSecureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
        if (key === "user-app.store-key" && mockFailStoreKeyWrites > 0) {
            mockFailStoreKeyWrites--
            throw new Error("keystore unavailable")
        }
        mockWriteOrder.push("secure-store")
        mockSecureStore.set(key, value)
    },
    deleteItemAsync: async (key: string) => {
        mockEraseOrder.push(`secure-store:${key}`)
        mockSecureStore.delete(key)
    }
}))

jest.mock("@react-native-async-storage/async-storage", () => ({
    getItem: async (key: string) => mockAsyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
        mockWriteOrder.push("async-storage")
        mockAsyncStorage.set(key, value)
    },
    removeItem: async (key: string) => {
        mockAsyncStorage.delete(key)
    },
    getAllKeys: async () => Array.from(mockAsyncStorage.keys()),
    clear: async () => {
        mockEraseOrder.push("async-storage:clear")
        mockAsyncStorage.clear()
    }
}))

import { createDeviceStore, eraseDeviceStore } from "../store"

const STORE_KEY = "user-app.store-key"
const raw = (key: string) => mockAsyncStorage.get(key) as string

// Erasing also drops the module's cached store key, so no test inherits the previous one.
beforeEach(async () => {
    mockSecureStore.clear()
    mockAsyncStorage.clear()
    await eraseDeviceStore()
    mockWriteOrder.length = 0
    mockEraseOrder.length = 0
    mockFailStoreKeyWrites = 0
})

describe("createDeviceStore", () => {
    // AsyncStorage still gets one entry for each of these: the adapter's own secret index, since
    // SecureStore cannot enumerate its own keys. The value itself is what must stay out of it.
    it("routes a wallet key to SecureStore, not AsyncStorage", async () => {
        const store = createDeviceStore()

        await store.set("key:networkId-1", "p-256-private-key")

        expect(Array.from(mockSecureStore.values())).toContain("p-256-private-key")
        expect(Array.from(mockAsyncStorage.values())).not.toContain("p-256-private-key")
        expect(await store.get("key:networkId-1")).toBe("p-256-private-key")
    })

    // A crash between the two writes must leave the index pointing at a secret that never landed,
    // not a secret `list()` can never find and erase can never delete.
    it("writes the index entry before the secret itself", async () => {
        const store = createDeviceStore()

        await store.set("key:networkId-1", "p-256-private-key")

        expect(mockWriteOrder).toEqual(["async-storage", "secure-store"])
    })

    it("routes the device secret to SecureStore", async () => {
        const store = createDeviceStore()

        await store.set("user-app-core:device-secret", "0xabc")

        expect(Array.from(mockSecureStore.values())).toContain("0xabc")
        expect(Array.from(mockAsyncStorage.values())).not.toContain("0xabc")
        expect(await store.get("user-app-core:device-secret")).toBe("0xabc")
    })

    // `Wallet` stores a credential's revocation secret under `revsec:`, apart from the credential
    // itself, precisely so this adapter can send the two to different backends. A credential is far
    // past SecureStore's couple-of-kilobyte ceiling; its revocation secret must never miss it.
    it("routes a credential's revocation secret to SecureStore", async () => {
        const store = createDeviceStore()
        await store.set("revsec:urn:uuid:abc", "0x" + "11".repeat(32))

        expect(mockSecureStore.size).toBe(1)
        expect(mockAsyncStorage.has("revsec:urn:uuid:abc")).toBe(false)
        expect(await store.get("revsec:urn:uuid:abc")).toBe("0x" + "11".repeat(32))
    })

    it("routes a credential well over 2 KB to AsyncStorage, sealed, and keeps it out of SecureStore", async () => {
        const store = createDeviceStore()
        const credential = JSON.stringify({ proof: "a".repeat(3000) })
        expect(credential.length).toBeGreaterThan(2048)

        await store.set("vc:credential-1", credential)

        const stored = mockAsyncStorage.get("vc:credential-1")
        expect(stored).not.toBe(credential)
        expect(stored).not.toContain('"proof"')
        expect(stored).not.toContain("a".repeat(32))
        expect(stored?.startsWith("enc1:")).toBe(true)
        expect(Array.from(mockSecureStore.values())).not.toContain(stored)
        expect(await store.get("vc:credential-1")).toBe(credential)
    })

    it("list() returns keys from both backends", async () => {
        const store = createDeviceStore()

        await store.set("key:networkId-1", "secret")
        await store.set("vc:credential-1", "credential-body")

        const keys = await store.list()

        expect(new Set(keys)).toEqual(new Set(["key:networkId-1", "vc:credential-1"]))
    })

    it("list() never leaks the adapter's own secret index", async () => {
        const store = createDeviceStore()
        await store.set("key:networkId-1", "secret")

        expect(await store.list()).not.toContain("user-app.secret-index")
    })

    it("delete() removes a secret from SecureStore and its index entry", async () => {
        const store = createDeviceStore()
        await store.set("key:networkId-1", "secret")

        await store.delete("key:networkId-1")

        expect(mockSecureStore.size).toBe(0)
        expect(await store.list()).toEqual([])
    })

    // "key:a:" and "key:a_3a" encode to the same string unless `_` is escaped too — `_3a` is the
    // literal escape sequence `encodeKey` would otherwise produce for the `:` in the first key.
    // A credential id comes from the issuer's server during `credential.issue`, so `revsec:<id>`
    // is a SecureStore key this app does not choose. Variable-width escaping collided these two.
    it("does not collide two caller-chosen credential ids that differ only in escaping", async () => {
        const store = createDeviceStore()
        await store.set("revsec:a\u000c0", "first-secret")
        await store.set("revsec:a\u00c0", "second-secret")

        expect(mockSecureStore.size).toBe(2)
        expect(await store.get("revsec:a\u000c0")).toBe("first-secret")
        expect(await store.get("revsec:a\u00c0")).toBe("second-secret")
    })

    it("does not collide a key containing a literal underscore with another key's escape sequence", async () => {
        const store = createDeviceStore()

        await store.set("key:a:", "first-secret")
        await store.set("key:a_3a", "second-secret")

        expect(await store.get("key:a:")).toBe("first-secret")
        expect(await store.get("key:a_3a")).toBe("second-secret")
        expect(mockSecureStore.size).toBe(2)
    })
})

describe("store key", () => {
    it("is a single SecureStore item, absent from AsyncStorage and list()", async () => {
        const store = createDeviceStore()

        await store.set("vc:credential-1", "body")

        expect(Array.from(mockSecureStore.keys())).toEqual([STORE_KEY])
        expect(mockAsyncStorage.has(STORE_KEY)).toBe(false)
        expect(await store.list()).toEqual(["vc:credential-1"])
    })

    it("is generated once when two first writes race", async () => {
        const store = createDeviceStore()

        await Promise.all([store.set("vc:a", "first"), store.set("vc:b", "second")])

        expect(mockSecureStore.size).toBe(1)
        expect(await store.get("vc:a")).toBe("first")
        expect(await store.get("vc:b")).toBe("second")
    })

    it("is not created by a read of an absent record or by a secret write", async () => {
        const store = createDeviceStore()

        expect(await store.get("vc:missing")).toBeNull()
        expect(mockSecureStore.size).toBe(0)

        await store.set("user-app-core:device-secret", "0xabc")

        expect(mockSecureStore.size).toBe(1)
        expect(mockSecureStore.has(STORE_KEY)).toBe(false)
    })

    it("is retried by the next write after a generation failure", async () => {
        const store = createDeviceStore()
        mockFailStoreKeyWrites = 1

        await expect(store.set("vc:a", "body")).rejects.toThrow("keystore unavailable")
        expect(mockAsyncStorage.has("vc:a")).toBe(false)

        await store.set("vc:a", "body")
        expect(mockSecureStore.has(STORE_KEY)).toBe(true)
        expect(await store.get("vc:a")).toBe("body")
    })

    it("is replaced by a new one after an erase", async () => {
        const store = createDeviceStore()
        await store.set("vc:a", "body")
        const first = mockSecureStore.get(STORE_KEY)

        await eraseDeviceStore()
        expect(mockSecureStore.has(STORE_KEY)).toBe(false)

        await store.set("vc:a", "body")
        expect(mockSecureStore.get(STORE_KEY)).toBeDefined()
        expect(mockSecureStore.get(STORE_KEY)).not.toBe(first)
    })
})

describe("sealed records", () => {
    const UNREADABLE = "store: a stored record cannot be decrypted"

    it("migrates legacy plaintext on first read, creating the store key", async () => {
        const store = createDeviceStore()
        mockAsyncStorage.set("vc:legacy", '{"id":"legacy"}')
        expect(mockSecureStore.has(STORE_KEY)).toBe(false)

        expect(await store.get("vc:legacy")).toBe('{"id":"legacy"}')

        expect(mockSecureStore.has(STORE_KEY)).toBe(true)
        expect(mockAsyncStorage.get("vc:legacy")?.startsWith("enc1:")).toBe(true)
        expect(await store.get("vc:legacy")).toBe('{"id":"legacy"}')
    })

    it("does not let a migration overwrite a concurrent set()", async () => {
        const store = createDeviceStore()
        mockAsyncStorage.set("vc:legacy", "old")

        await Promise.all([store.get("vc:legacy"), store.set("vc:legacy", "new")])

        expect(await store.get("vc:legacy")).toBe("new")
    })

    it("does not let a migration restore a record a concurrent delete() removed", async () => {
        const store = createDeviceStore()
        mockAsyncStorage.set("vc:legacy", "old")

        await Promise.all([store.get("vc:legacy"), store.delete("vc:legacy")])

        expect(mockAsyncStorage.has("vc:legacy")).toBe(false)
    })

    it("still runs a set() queued behind a get() that fails", async () => {
        const store = createDeviceStore()
        await store.set("vc:other", "body")
        mockAsyncStorage.set("vc:a", "enc1:")

        const [read] = await Promise.allSettled([store.get("vc:a"), store.set("vc:a", "new")])

        expect(read.status).toBe("rejected")
        expect(await store.get("vc:a")).toBe("new")
    })

    it("rejects an envelope copied to another key", async () => {
        const store = createDeviceStore()
        await store.set("vc:a", "body")
        mockAsyncStorage.set("vc:b", raw("vc:a"))

        await expect(store.get("vc:b")).rejects.toThrow(UNREADABLE)
    })

    it("rejects a modified envelope and keeps the record", async () => {
        const store = createDeviceStore()
        await store.set("vc:a", "body")
        const envelope = raw("vc:a")
        const flipped = envelope.slice(0, -1) + (envelope.endsWith("0") ? "1" : "0")
        mockAsyncStorage.set("vc:a", flipped)

        await expect(store.get("vc:a")).rejects.toThrow(UNREADABLE)
        expect(mockAsyncStorage.get("vc:a")).toBe(flipped)
    })

    it.each([
        ["nothing after the prefix", "enc1:"],
        ["an odd-length body", "enc1:abc"],
        ["a non-hex body", "enc1:" + "zz".repeat(40)],
        ["a body shorter than nonce and tag", "enc1:" + "ab".repeat(10)]
    ])("rejects an envelope with %s", async (_name, envelope) => {
        const store = createDeviceStore()
        await store.set("vc:other", "body")
        mockAsyncStorage.set("vc:a", envelope)

        await expect(store.get("vc:a")).rejects.toThrow(UNREADABLE)
        expect(mockAsyncStorage.get("vc:a")).toBe(envelope)
    })

    it("names no storage key in the error", async () => {
        const store = createDeviceStore()
        await store.set("vc:secret-credential-id", "body")
        mockAsyncStorage.set("vc:moved-credential-id", raw("vc:secret-credential-id"))

        const error = await store.get("vc:moved-credential-id").catch((e: Error) => e)

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(UNREADABLE)
        expect((error as Error).message).not.toContain("moved-credential-id")
    })

    it("seals the same value differently on each write and under each key", async () => {
        const store = createDeviceStore()

        await store.set("vc:a", "same")
        const first = mockAsyncStorage.get("vc:a")
        await store.set("vc:a", "same")
        const second = mockAsyncStorage.get("vc:a")
        await store.set("vc:b", "same")

        expect(second).not.toBe(first)
        expect(mockAsyncStorage.get("vc:b")).not.toBe(second)
        expect(await store.get("vc:a")).toBe("same")
        expect(await store.get("vc:b")).toBe("same")
    })

    it("round-trips non-ASCII values", async () => {
        const store = createDeviceStore()
        const value = "Ünïcødé ✓ 漢字"

        await store.set("vc:a", value)

        expect(await store.get("vc:a")).toBe(value)
    })

    it("rejects an envelope whose store key is gone", async () => {
        const store = createDeviceStore()
        await store.set("vc:a", "body")
        const envelope = raw("vc:a")
        await eraseDeviceStore()
        mockAsyncStorage.set("vc:a", envelope)

        await expect(store.get("vc:a")).rejects.toThrow(UNREADABLE)
        expect(mockSecureStore.size).toBe(0)
    })
})

describe("AsyncStorage records", () => {
    it("delete() of a non-secret key removes its envelope and keeps the store key", async () => {
        const store = createDeviceStore()
        await store.set("vc:a", "body")

        await store.delete("vc:a")

        expect(mockAsyncStorage.has("vc:a")).toBe(false)
        expect(mockSecureStore.has(STORE_KEY)).toBe(true)
        expect(await store.get("vc:a")).toBeNull()
    })

    it("list() returns plain names after mixed writes and none of the adapter's own keys", async () => {
        const store = createDeviceStore()
        await store.set("vc:a", "body")
        await store.set("user-app-core:issuer-index:x", "index")
        await store.set("key:networkId-1", "secret")
        await store.set("user-app-core:device-secret", "0xabc")

        const keys = await store.list()

        expect(new Set(keys)).toEqual(
            new Set(["vc:a", "user-app-core:issuer-index:x", "key:networkId-1", "user-app-core:device-secret"])
        )
        expect(keys).not.toContain(STORE_KEY)
        expect(keys).not.toContain("user-app.secret-index")
    })

    it("leaves a foreign AsyncStorage entry untouched", async () => {
        const store = createDeviceStore()
        const foreign = '{"url":"http://localhost:3000"}'
        mockAsyncStorage.set("user-app.stack-config", foreign)

        await store.set("vc:a", "body")
        await store.get("vc:a")
        await store.list()
        await store.delete("vc:a")

        expect(mockAsyncStorage.get("user-app.stack-config")).toBe(foreign)
    })
})

describe("eraseDeviceStore", () => {
    it("wipes both backends", async () => {
        const store = createDeviceStore()
        await store.set("key:networkId-1", "secret")
        await store.set("vc:credential-1", "credential-body")

        await eraseDeviceStore()

        expect(mockSecureStore.size).toBe(0)
        expect(mockAsyncStorage.size).toBe(0)
    })

    it("deletes indexed secrets, then clears AsyncStorage, then deletes the store key last", async () => {
        const store = createDeviceStore()
        await store.set("key:networkId-1", "secret")
        await store.set("vc:a", "body")
        mockEraseOrder.length = 0

        await eraseDeviceStore()

        expect(mockEraseOrder).toEqual([
            "secure-store:key_003anetworkId-1",
            "async-storage:clear",
            `secure-store:${STORE_KEY}`
        ])
    })
})
