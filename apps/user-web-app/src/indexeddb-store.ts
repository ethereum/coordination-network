import type { Store } from "@coordination-network/wallet"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"

const STORE_NAME = "key-values"
const KEY_STORE = "encryption-keys"
const KEY_NAME = "wallet"
const UNREADABLE = "Wallet storage could not be opened. Clear the wallet to start again."
const CHANGED = "Wallet storage changed. Please try again."
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

type StoredKey = { id: string; key: CryptoKey }

function encrypted(value: string): boolean {
    return /^enc\d+:/.test(value)
}

function storedKey(value: unknown): StoredKey {
    const record = value as StoredKey | undefined
    if (
        !record ||
        typeof record.id !== "string" ||
        record.key?.type !== "secret" ||
        record.key.extractable !== false ||
        record.key.algorithm.name !== "AES-GCM" ||
        (record.key.algorithm as AesKeyAlgorithm).length !== 256 ||
        !record.key.usages.includes("encrypt") ||
        !record.key.usages.includes("decrypt")
    ) {
        throw new Error(UNREADABLE)
    }
    return record
}

export class IndexedDbStore implements Store {
    private readonly database: Promise<IDBDatabase>
    private initialization?: Promise<void>

    constructor(name = "coordination-user-app", indexedDb: IDBFactory = indexedDB) {
        this.database = new Promise((resolve, reject) => {
            const request = indexedDb.open(name, 2)
            let blocked = false
            request.onerror = () => reject(request.error)
            request.onblocked = () => {
                blocked = true
                reject(new Error("Close other wallet tabs and try again."))
            }
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME)
                }
                request.result.createObjectStore(KEY_STORE)
            }
            request.onsuccess = () => {
                const database = request.result
                database.onversionchange = () => database.close()
                if (blocked) database.close()
                else resolve(database)
            }
        })
    }

    private async transaction<T>(
        mode: IDBTransactionMode,
        run: (values: IDBObjectStore, keys: IDBObjectStore, fail: (error: Error) => void) => () => T
    ): Promise<T> {
        const database = await this.database
        return new Promise((resolve, reject) => {
            const transaction = database.transaction([STORE_NAME, KEY_STORE], mode)
            let failure: Error | undefined
            const fail = (error: Error) => {
                failure = error
                transaction.abort()
            }
            transaction.onabort = () => reject(failure ?? transaction.error ?? new Error(UNREADABLE))
            try {
                const result = run(transaction.objectStore(STORE_NAME), transaction.objectStore(KEY_STORE), fail)
                transaction.oncomplete = () => resolve(result())
            } catch (error) {
                fail(error instanceof Error ? error : new Error(UNREADABLE))
            }
        })
    }

    private async encryptionKey(): Promise<StoredKey> {
        const existing = await this.transaction("readonly", (_, keys) => {
            const request = keys.get(KEY_NAME)
            return () => request.result
        })
        if (existing !== undefined) return storedKey(existing)
        if (!globalThis.crypto?.subtle) throw new Error("This wallet requires HTTPS or localhost and WebCrypto.")

        const candidate: StoredKey = {
            id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
            key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        }
        const selected = await this.transaction("readwrite", (values, keys, fail) => {
            const request = keys.get(KEY_NAME)
            let record: unknown
            request.onsuccess = () => {
                if (request.result !== undefined) {
                    record = request.result
                    return
                }
                const entries = values.getAll()
                entries.onsuccess = () => {
                    // A missing key must never silently replace the key for existing ciphertext.
                    if (entries.result.some((value) => typeof value !== "string" || encrypted(value))) {
                        fail(new Error(UNREADABLE))
                        return
                    }
                    record = candidate
                    keys.put(candidate, KEY_NAME)
                }
            }
            return () => record
        })
        return storedKey(selected)
    }

    private async seal(key: string, value: string, record: StoredKey): Promise<string> {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: encoder.encode(key) },
            record.key,
            encoder.encode(value)
        )
        return `enc1:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`
    }

    private async open(key: string, value: string, record: unknown): Promise<string> {
        try {
            const match = /^enc1:([0-9a-f]{24}):((?:[0-9a-f]{2}){16,})$/.exec(value)
            if (!match) throw new Error(UNREADABLE)
            const plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(hexToBytes(match[1])), additionalData: encoder.encode(key) },
                storedKey(record).key,
                new Uint8Array(hexToBytes(match[2]))
            )
            return decoder.decode(plaintext)
        } catch {
            throw new Error(UNREADABLE)
        }
    }

    private async writeWithKey<T>(record: StoredKey, run: (values: IDBObjectStore) => () => T): Promise<T> {
        return this.transaction("readwrite", (values, keys, fail) => {
            const request = keys.get(KEY_NAME)
            let result: () => T
            request.onsuccess = () => {
                if (request.result?.id !== record.id) {
                    fail(new Error(CHANGED))
                    return
                }
                result = run(values)
            }
            return () => result()
        })
    }

    private async migrate(): Promise<void> {
        const entries = await this.transaction("readonly", (values) => {
            const keys = values.getAllKeys()
            const records = values.getAll()
            return () => keys.result.map((key, index) => ({ key, value: records.result[index] as unknown }))
        })
        if (entries.length === 0) return
        const record = await this.encryptionKey()
        const plaintext = entries.flatMap(({ key, value }) => {
            if (typeof key !== "string" || typeof value !== "string") throw new Error(UNREADABLE)
            return encrypted(value) ? [] : [{ key, value }]
        })
        const sealed = await Promise.all(
            plaintext.map(async (entry) => ({ ...entry, envelope: await this.seal(entry.key, entry.value, record) }))
        )
        if (sealed.length === 0) return
        await this.writeWithKey(record, (values) => {
            for (const { key, value, envelope } of sealed) {
                const current = values.get(key)
                current.onsuccess = () => {
                    // Another tab may have written or deleted the record while encryption was running.
                    if (current.result === value) values.put(envelope, key)
                }
            }
            return () => undefined
        })
    }

    private initialize(): Promise<void> {
        return (this.initialization ??= this.migrate())
    }

    async get(key: string): Promise<string | null> {
        await this.initialize()
        const { value, record } = await this.transaction("readonly", (values, keys) => {
            const value = values.get(key)
            const record = keys.get(KEY_NAME)
            return () => ({ value: value.result as unknown, record: record.result as unknown })
        })
        if (value === undefined) return null
        if (typeof value !== "string" || !encrypted(value)) throw new Error(UNREADABLE)
        return this.open(key, value, record)
    }

    async set(key: string, value: string): Promise<void> {
        await this.initialize()
        const record = await this.encryptionKey()
        const envelope = await this.seal(key, value, record)
        await this.writeWithKey(record, (values) => {
            values.put(envelope, key)
            return () => undefined
        })
    }

    async delete(key: string): Promise<void> {
        await this.transaction("readwrite", (values) => {
            values.delete(key)
            return () => undefined
        })
    }

    async list(): Promise<string[]> {
        await this.initialize()
        return this.transaction("readonly", (values) => {
            const request = values.getAllKeys()
            return () => request.result.map(String)
        })
    }

    async clear(): Promise<void> {
        await this.transaction("readwrite", (values, keys) => {
            values.clear()
            keys.clear()
            return () => undefined
        })
        this.initialization = undefined
    }
}

/** Gives each member its own wallet records while keeping one browser database. */
export class PrefixedStore implements Store {
    constructor(
        private readonly store: Store,
        private readonly prefix: string
    ) {}

    async get(key: string): Promise<string | null> {
        return this.store.get(`${this.prefix}${key}`)
    }
    async set(key: string, value: string): Promise<void> {
        await this.store.set(`${this.prefix}${key}`, value)
    }
    async delete(key: string): Promise<void> {
        await this.store.delete(`${this.prefix}${key}`)
    }
    async list(): Promise<string[]> {
        return (await this.store.list())
            .filter((key) => key.startsWith(this.prefix))
            .map((key) => key.slice(this.prefix.length))
    }
}
