import { webcrypto } from "node:crypto"
import { IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb"
import { loadOrCreateIdentity } from "../src/identity"
import { IndexedDbStore, PrefixedStore } from "../src/indexeddb-store"
import { resetWallet } from "../src/navigation"

beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto })
})

afterEach(() => jest.restoreAllMocks())

async function raw<T>(
    indexedDb: IDBFactory,
    name: string,
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDb.open(name)
        request.onupgradeneeded = () => request.result.createObjectStore("key-values")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    try {
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(storeName, mode)
            const request = run(transaction.objectStore(storeName))
            transaction.oncomplete = () => resolve(request.result)
            transaction.onabort = () => reject(transaction.error ?? request.error)
        })
    } finally {
        database.close()
    }
}

function pauseEncryption() {
    let started!: () => void
    let resume!: () => void
    const pending = new Promise<void>((resolve) => {
        started = resolve
    })
    const gate = new Promise<void>((resolve) => {
        resume = resolve
    })
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    jest.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
        started()
        await gate
        return encrypt(...args)
    })
    return { pending, resume }
}

describe("IndexedDbStore", () => {
    it("encrypts identity and credential values before persisting them", async () => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("encrypted", indexedDb)
        const identity = JSON.stringify({ deviceSecret: "private secret", devicePrivateKey: "private key" })
        await store.set("app:identity", identity)
        await store.set("member:vc:approval", "private credential")

        const values = await raw(indexedDb, "encrypted", "key-values", "readonly", (records) => records.getAll())
        expect(values).toHaveLength(2)
        for (const value of values) {
            expect(value).toMatch(/^enc1:/)
            expect(value).not.toContain("private")
        }
        expect(await store.get("app:identity")).toBe(identity)
        expect(await store.get("member:vc:approval")).toBe("private credential")
    })

    it("migrates all existing plaintext records, including records that are not read", async () => {
        const indexedDb = new IDBFactory()
        await raw(indexedDb, "legacy", "key-values", "readwrite", (records) => records.put("alice", "app:identity"))
        await raw(indexedDb, "legacy", "key-values", "readwrite", (records) =>
            records.put("private credential", "member:vc:approval")
        )

        const store = new IndexedDbStore("legacy", indexedDb)
        expect(await store.get("app:identity")).toBe("alice")
        const values = await raw(indexedDb, "legacy", "key-values", "readonly", (records) => records.getAll())
        expect(values).toHaveLength(2)
        expect(values.every((value) => typeof value === "string" && value.startsWith("enc1:"))).toBe(true)
        expect(await store.get("member:vc:approval")).toBe("private credential")
    })

    it("persists, lists, deletes and clears string values", async () => {
        const indexedDb = new IDBFactory()
        const first = new IndexedDbStore("test", indexedDb)
        await first.set("identity", "alice")
        await first.set("credential", "alpha")

        const reopened = new IndexedDbStore("test", indexedDb)
        expect(await reopened.get("identity")).toBe("alice")
        expect((await reopened.list()).sort()).toEqual(["credential", "identity"])
        await reopened.delete("credential")
        expect(await reopened.get("credential")).toBeNull()
        await reopened.clear()
        expect(await reopened.list()).toEqual([])
    })

    it("persists a non-extractable key across reloads and uses a fresh IV on every write", async () => {
        const indexedDb = new IDBFactory()
        const first = new IndexedDbStore("key", indexedDb)
        await first.set("identity", "alice")
        const key = (await raw(indexedDb, "key", "encryption-keys", "readonly", (keys) => keys.get("wallet"))) as {
            id: string
            key: CryptoKey
        }
        expect(key.key.extractable).toBe(false)
        expect(key.key.algorithm).toEqual({ name: "AES-GCM", length: 256 })
        await expect(crypto.subtle.exportKey("raw", key.key)).rejects.toThrow()
        const before = await raw(indexedDb, "key", "key-values", "readonly", (values) => values.get("identity"))

        const reopened = new IndexedDbStore("key", indexedDb)
        expect(await reopened.get("identity")).toBe("alice")
        await reopened.set("identity", "alice")
        const after = await raw(indexedDb, "key", "key-values", "readonly", (values) => values.get("identity"))
        expect(after).not.toBe(before)
        const saved = await raw(indexedDb, "key", "encryption-keys", "readonly", (keys) => keys.get("wallet"))
        expect(saved.id).toBe(key.id)
        expect((await reopened.list()).sort()).toEqual(["identity"])
    })

    it("uses one key when separate tabs write for the first time together", async () => {
        const indexedDb = new IDBFactory()
        const alpha = new IndexedDbStore("concurrent", indexedDb)
        const beta = new IndexedDbStore("concurrent", indexedDb)
        await Promise.all([alpha.set("alpha", "first"), beta.set("beta", "second")])
        const reopened = new IndexedDbStore("concurrent", indexedDb)
        expect(await reopened.get("alpha")).toBe("first")
        expect(await reopened.get("beta")).toBe("second")
        expect(await raw(indexedDb, "concurrent", "encryption-keys", "readonly", (keys) => keys.count())).toBe(1)
    })

    it.each(["", "Approval: 日本語 😀"])("round trips a string without changing it: %s", async (value) => {
        const store = new IndexedDbStore("strings", new IDBFactory())
        await store.set("record", value)
        expect(await store.get("record")).toBe(value)
    })

    it("preserves the existing identity through migration and reopening", async () => {
        const indexedDb = new IDBFactory()
        const identity = JSON.stringify({ deviceSecret: "11".repeat(32), devicePrivateKey: "22".repeat(32) })
        await raw(indexedDb, "identity", "key-values", "readwrite", (records) => records.put(identity, "app:identity"))
        const first = await loadOrCreateIdentity(new IndexedDbStore("identity", indexedDb))
        const reopened = await loadOrCreateIdentity(new IndexedDbStore("identity", indexedDb))
        expect(reopened.deviceSecret).toEqual(first.deviceSecret)
        expect(reopened.identityCommitment).toBe(first.identityCommitment)
        expect(reopened.metaStealthAddress).toBe(first.metaStealthAddress)
        expect(await new IndexedDbStore("identity", indexedDb).get("app:identity")).toBe(identity)
    })

    it.each(["write", "delete"])("does not undo a concurrent %s while migrating", async (operation) => {
        const indexedDb = new IDBFactory()
        await raw(indexedDb, "migration", "key-values", "readwrite", (values) => values.put("old", "identity"))
        const pause = pauseEncryption()
        const migrating = new IndexedDbStore("migration", indexedDb).get("identity")
        await pause.pending
        const other = new IndexedDbStore("migration", indexedDb)
        try {
            if (operation === "write") await other.set("identity", "new")
            else await other.delete("identity")
        } finally {
            pause.resume()
        }
        expect(await migrating).toBe(operation === "write" ? "new" : null)
    })

    it("leaves plaintext records intact when migration encryption fails", async () => {
        const indexedDb = new IDBFactory()
        await raw(indexedDb, "failure", "key-values", "readwrite", (values) => values.put("old", "identity"))
        const store = new IndexedDbStore("failure", indexedDb)
        jest.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("Encryption unavailable"))
        await expect(store.get("identity")).rejects.toThrow("Encryption unavailable")
        expect(await raw(indexedDb, "failure", "key-values", "readonly", (values) => values.get("identity"))).toBe(
            "old"
        )
        jest.restoreAllMocks()
        expect(await new IndexedDbStore("failure", indexedDb).get("identity")).toBe("old")
    })

    it("rejects modified ciphertext without changing or exposing the saved record", async () => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("tampered", indexedDb)
        await store.set("identity", "secret")
        const saved = await raw(indexedDb, "tampered", "key-values", "readonly", (values) => values.get("identity"))
        const damaged = `${saved.slice(0, -1)}${saved.endsWith("0") ? "1" : "0"}`
        await raw(indexedDb, "tampered", "key-values", "readwrite", (values) => values.put(damaged, "identity"))
        await expect(new IndexedDbStore("tampered", indexedDb).get("identity")).rejects.toThrow(
            "Wallet storage could not be opened. Clear the wallet to start again."
        )
        expect(await raw(indexedDb, "tampered", "key-values", "readonly", (values) => values.get("identity"))).toBe(
            damaged
        )
    })

    it("rejects an encrypted record copied to a different member's key", async () => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("swapped", indexedDb)
        await store.set("alpha:vc:approval", "alpha approval")
        const saved = await raw(indexedDb, "swapped", "key-values", "readonly", (values) =>
            values.get("alpha:vc:approval")
        )
        await raw(indexedDb, "swapped", "key-values", "readwrite", (values) => values.put(saved, "beta:vc:approval"))
        await expect(store.get("beta:vc:approval")).rejects.toThrow("Wallet storage could not be opened")
        expect(await store.get("alpha:vc:approval")).toBe("alpha approval")
    })

    it.each(["enc1:broken", "enc2:unsupported", "enc1:000000000000000000000000:01"])(
        "rejects a malformed or unsupported envelope without migrating it: %s",
        async (damaged) => {
            const indexedDb = new IDBFactory()
            const store = new IndexedDbStore("malformed", indexedDb)
            await store.set("identity", "secret")
            await raw(indexedDb, "malformed", "key-values", "readwrite", (values) => values.put(damaged, "identity"))
            await expect(new IndexedDbStore("malformed", indexedDb).get("identity")).rejects.toThrow(
                "Wallet storage could not be opened"
            )
            expect(
                await raw(indexedDb, "malformed", "key-values", "readonly", (values) => values.get("identity"))
            ).toBe(damaged)
        }
    )

    it("does not replace a missing encryption key while ciphertext remains, and allows erase to recover", async () => {
        const indexedDb = new IDBFactory()
        await new IndexedDbStore("missing-key", indexedDb).set("identity", "secret")
        const saved = await raw(indexedDb, "missing-key", "key-values", "readonly", (values) => values.get("identity"))
        await raw(indexedDb, "missing-key", "encryption-keys", "readwrite", (keys) => keys.clear())
        const reopened = new IndexedDbStore("missing-key", indexedDb)
        await expect(reopened.get("identity")).rejects.toThrow("Wallet storage could not be opened")
        expect(await raw(indexedDb, "missing-key", "key-values", "readonly", (values) => values.get("identity"))).toBe(
            saved
        )
        expect(await raw(indexedDb, "missing-key", "encryption-keys", "readonly", (keys) => keys.count())).toBe(0)
        await resetWallet(reopened)
        expect(await raw(indexedDb, "missing-key", "encryption-keys", "readonly", (keys) => keys.count())).toBe(0)
        await reopened.set("identity", "new identity")
        expect(await reopened.get("identity")).toBe("new identity")
    })

    it("fails without WebCrypto rather than falling back to plaintext storage", async () => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("unsupported", indexedDb)
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined })
        try {
            await expect(store.set("identity", "secret")).rejects.toThrow("requires HTTPS or localhost and WebCrypto")
            expect(await raw(indexedDb, "unsupported", "key-values", "readonly", (values) => values.count())).toBe(0)
            await store.clear()
        } finally {
            Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto })
        }
    })

    it("erases records and the key together, then generates a new key on the next write", async () => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("erase", indexedDb)
        await store.set("identity", "alice")
        const before = await raw(indexedDb, "erase", "encryption-keys", "readonly", (keys) => keys.get("wallet"))
        await resetWallet(store)
        expect(await store.get("identity")).toBeNull()
        expect(await raw(indexedDb, "erase", "encryption-keys", "readonly", (keys) => keys.count())).toBe(0)
        await store.set("identity", "bob")
        const after = await raw(indexedDb, "erase", "encryption-keys", "readonly", (keys) => keys.get("wallet"))
        expect(after.id).not.toBe(before.id)
        expect(await new IndexedDbStore("erase", indexedDb).get("identity")).toBe("bob")
        await expect(crypto.subtle.exportKey("raw", after.key)).rejects.toThrow()
    })

    it.each(["migration", "write"])("does not restore data after erase interrupts %s", async (operation) => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("erase-race", indexedDb)
        if (operation === "migration") {
            await raw(indexedDb, "erase-race", "key-values", "readwrite", (values) => values.put("old", "identity"))
        } else {
            await store.set("identity", "old")
        }
        const pause = pauseEncryption()
        const pending = operation === "migration" ? store.get("identity") : store.set("identity", "new")
        const failure = pending.catch((error: unknown) => error)
        await pause.pending
        try {
            await new IndexedDbStore("erase-race", indexedDb).clear()
        } finally {
            pause.resume()
        }
        await expect(failure).resolves.toEqual(new Error("Wallet storage changed. Please try again."))
        expect(await raw(indexedDb, "erase-race", "key-values", "readonly", (values) => values.count())).toBe(0)
        expect(await raw(indexedDb, "erase-race", "encryption-keys", "readonly", (keys) => keys.count())).toBe(0)
    })

    it("rolls back record deletion if clearing the key store fails", async () => {
        const indexedDb = new IDBFactory()
        const store = new IndexedDbStore("erase-failure", indexedDb)
        await store.set("identity", "alice")
        const clear = FakeObjectStore.prototype.clear
        jest.spyOn(FakeObjectStore.prototype, "clear").mockImplementation(function (this: IDBObjectStore) {
            if (this.name === "encryption-keys") throw new Error("Clear failed")
            return clear.call(this)
        })
        await expect(store.clear()).rejects.toThrow("Clear failed")
        expect(await store.get("identity")).toBe("alice")
        expect(await raw(indexedDb, "erase-failure", "encryption-keys", "readonly", (keys) => keys.count())).toBe(1)
    })
})

describe("PrefixedStore", () => {
    it("isolates wallet records belonging to different members", async () => {
        const database = new IndexedDbStore("scoped", new IDBFactory())
        const alpha = new PrefixedStore(database, "alpha:")
        const beta = new PrefixedStore(database, "beta:")

        await alpha.set("vc:approval", "alpha approval")
        await beta.set("vc:approval", "beta approval")

        expect(await alpha.get("vc:approval")).toBe("alpha approval")
        expect(await beta.get("vc:approval")).toBe("beta approval")
        expect(await alpha.list()).toEqual(["vc:approval"])
        expect(await beta.list()).toEqual(["vc:approval"])
    })
})
