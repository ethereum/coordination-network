import AsyncStorage from "@react-native-async-storage/async-storage"
import * as SecureStore from "expo-secure-store"
import { gcm } from "@noble/ciphers/aes"
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from "@noble/ciphers/utils"
import { managedNonce, randomBytes } from "@noble/ciphers/webcrypto"
import { KEY_PREFIX, REVOCATION_SECRET_PREFIX, type Store } from "@coordination-network/wallet"
import { DEVICE_SECRET_KEY } from "@coordination-network/user-app-core"

/**
 * Values that must not leave the keystore-backed store, by key prefix: the device secret every
 * other key is derived from, and the per-credential revocation secrets.
 */
const SECRET_PREFIXES = [KEY_PREFIX, REVOCATION_SECRET_PREFIX, DEVICE_SECRET_KEY]

/** SecureStore cannot enumerate itself, so the adapter keeps its own index under this key. */
const SECRET_INDEX = "user-app.secret-index"

/**
 * SecureStore accepts only `[A-Za-z0-9._-]` in a key, so anything else is escaped as `_` plus the
 * code unit in **four** hex digits. The fixed width is what makes the scheme injective: with
 * variable-width hex, `"a\u000c0"` and `"a\u00c0"` both encode to `"a_c0"`. That matters because one
 * of these keys ends in a credential id the issuer's server chose during `credential.issue`, and a
 * collision would cross two credentials' revocation secrets. `_` is escaped too, so it only ever
 * appears as an escape introducer.
 */
const encodeKey = (key: string): string =>
    key.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, "0")}`)

const isSecret = (key: string): boolean => SECRET_PREFIXES.some((prefix) => key.startsWith(prefix))

/** The AES-256 key for AsyncStorage records. It lives in SecureStore but is not a secret-index entry. */
const STORE_KEY = "user-app.store-key"

/** Marks a sealed AsyncStorage value; anything else is a pre-encryption record. */
const ENVELOPE_PREFIX = "enc1:"

const UNREADABLE = "store: a stored record cannot be decrypted"

// Assigned before the first await so two concurrent first writes share one generation.
let storeKey: Promise<Uint8Array> | null = null

async function loadStoreKey(create: boolean): Promise<Uint8Array> {
    const stored = await SecureStore.getItemAsync(STORE_KEY)
    if (stored !== null) return hexToBytes(stored)
    if (!create) throw new Error(UNREADABLE)
    const fresh = randomBytes(32)
    await SecureStore.setItemAsync(STORE_KEY, bytesToHex(fresh))
    return fresh
}

function getStoreKey(create: boolean): Promise<Uint8Array> {
    if (storeKey === null) {
        const pending = loadStoreKey(create)
        storeKey = pending
        pending.catch(() => {
            if (storeKey === pending) storeKey = null
        })
    }
    return storeKey
}

// The AsyncStorage key is the associated data, so an envelope moved to another key fails to open.
async function seal(key: string, value: string): Promise<string> {
    const cipher = managedNonce(gcm)(await getStoreKey(true), utf8ToBytes(key))
    return ENVELOPE_PREFIX + bytesToHex(cipher.encrypt(utf8ToBytes(value)))
}

async function open(key: string, envelope: string): Promise<string> {
    const aesKey = await getStoreKey(false)
    try {
        const cipher = managedNonce(gcm)(aesKey, utf8ToBytes(key))
        return bytesToUtf8(cipher.decrypt(hexToBytes(envelope.slice(ENVELOPE_PREFIX.length))))
    } catch {
        throw new Error(UNREADABLE)
    }
}

// AsyncStorage calls on one key run in call order, so get()'s migration write-back cannot land
// after a later set() or delete() of that key.
const queues = new Map<string, Promise<void>>()

function inOrder<T>(key: string, task: () => Promise<T>): Promise<T> {
    const release = (): void => {
        if (queues.get(key) === tail) queues.delete(key)
    }
    const result = (queues.get(key) ?? Promise.resolve()).then(task)
    const tail = result.then(release, release)
    queues.set(key, tail)
    return result
}

async function readIndex(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(SECRET_INDEX)
    return raw === null ? [] : (JSON.parse(raw) as string[])
}

async function writeIndex(keys: string[]): Promise<void> {
    await AsyncStorage.setItem(SECRET_INDEX, JSON.stringify(keys))
}

/**
 * `Store` split across two backends. Android's SecureStore warns and can fail above about 2 KB,
 * and a credential is comfortably larger than that, so only the secrets go there. Credentials and
 * the issuer index are private, so they go to AsyncStorage as AES-256-GCM envelopes under a key
 * held in SecureStore; the key names stay readable.
 *
 * `user-app.stack-config` (config.ts) and `user-app.verification-key.*` (prover.ts) bypass this
 * store, so they stay plaintext.
 */
export function createDeviceStore(): Store {
    return {
        async get(key) {
            if (isSecret(key)) return SecureStore.getItemAsync(encodeKey(key))
            return inOrder(key, async () => {
                const stored = await AsyncStorage.getItem(key)
                if (stored === null) return null
                if (stored.startsWith(ENVELOPE_PREFIX)) return open(key, stored)
                await AsyncStorage.setItem(key, await seal(key, stored))
                return stored
            })
        },

        async set(key, value) {
            if (!isSecret(key)) {
                await inOrder(key, async () => AsyncStorage.setItem(key, await seal(key, value)))
                return
            }
            // Index before secret: a crash in between leaves an index entry with no secret behind
            // it, which get() reads as missing and erase() deletes — harmless. The reverse would
            // leave a secret that list() never returns and erase() never deletes.
            const index = await readIndex()
            if (!index.includes(key)) await writeIndex([...index, key])
            await SecureStore.setItemAsync(encodeKey(key), value)
        },

        async delete(key) {
            if (!isSecret(key)) {
                await inOrder(key, () => AsyncStorage.removeItem(key))
                return
            }
            await SecureStore.deleteItemAsync(encodeKey(key))
            await writeIndex((await readIndex()).filter((entry) => entry !== key))
        },

        async list() {
            const [secrets, plain] = await Promise.all([readIndex(), AsyncStorage.getAllKeys()])
            return [...secrets, ...plain.filter((key) => key !== SECRET_INDEX)]
        }
    }
}

/** Wipes everything this adapter owns; the keystore alias is erased separately. */
export async function eraseDeviceStore(): Promise<void> {
    try {
        const secrets = await readIndex()
        await Promise.all(secrets.map((key) => SecureStore.deleteItemAsync(encodeKey(key))))
        await AsyncStorage.clear()
        // Last, so a crash midway leaves a key without envelopes, never envelopes without a key.
        await SecureStore.deleteItemAsync(STORE_KEY)
    } finally {
        storeKey = null
    }
}
