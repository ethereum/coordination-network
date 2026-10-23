import { hexToBytes } from "viem"
import { createKeyCipher } from "../../src/keyCipher.ts"
import { key1, keyCipher } from "../utils/fixtures.ts"

// nonce (12) + the encrypted 32-byte key + GCM auth tag (16)
const STORED_BYTES = 60

// encrypted with the fixtures' key cipher
const STORED_VIEWING_PRIVATE_KEY =
    "0x85540a8790b8837c2033dc6620691815315d179c09ad7d8cacd5049c84e4ba0a644e360e731ca7762f146963eae5d2bad0f1d30227fe33a4e53ae063"

test("decrypt rejects a value encrypted under a different encryption key", () => {
    const otherKeyCipher = createKeyCipher({
        encryptionKey: hexToBytes(`0x${"99".repeat(32)}`),
        lookupHashKey: hexToBytes(`0x${"0f".repeat(32)}`)
    })
    const encryptedElsewhere = otherKeyCipher.encrypt(key1.viewingPrivateKey)

    expect(() => keyCipher.decrypt(encryptedElsewhere)).toThrow()
})

test("decrypt rejects a tampered auth tag", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)
    // the last two characters are the end of the GCM auth tag
    const tampered = `${encrypted.slice(0, -2)}ff` as typeof encrypted

    expect(() => keyCipher.decrypt(tampered)).toThrow()
})

test("decrypt rejects a tampered nonce", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)
    // the nonce is the first 12 bytes, ahead of the encrypted value
    const tampered = `0xff${encrypted.slice(4)}` as typeof encrypted

    expect(() => keyCipher.decrypt(tampered)).toThrow()
})

test("decrypt rejects a tampered value body", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)
    const tampered = `${encrypted.slice(0, 30)}ff${encrypted.slice(32)}` as typeof encrypted

    expect(() => keyCipher.decrypt(tampered)).toThrow()
})

test("decrypt rejects a value too short to hold a nonce and tag", () => {
    expect(() => keyCipher.decrypt(`0x${"11".repeat(20)}`)).toThrow()
})

test("decrypt rejects an empty value", () => {
    expect(() => keyCipher.decrypt("0x")).toThrow()
})

test("encrypt never stores the value in the clear", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)

    expect(encrypted).not.toContain(key1.viewingPrivateKey.slice(2))
})

test("encrypt uses a fresh nonce for every write", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)
    const encryptedAgain = keyCipher.encrypt(key1.viewingPrivateKey)

    // a repeated ciphertext would leak that two entities share a key
    expect(encrypted).not.toBe(encryptedAgain)
})

test("encrypt stores a nonce, the value and a tag", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)

    // catches an encrypt that silently returned a promise, which would still round-trip as a string
    expect(hexToBytes(encrypted)).toHaveLength(STORED_BYTES)
})

test("decrypt reads a value stored by an earlier run", () => {
    expect(keyCipher.decrypt(STORED_VIEWING_PRIVATE_KEY)).toBe(key1.viewingPrivateKey)
})

test("decrypt returns what was encrypted", () => {
    const encrypted = keyCipher.encrypt(key1.viewingPrivateKey)

    expect(keyCipher.decrypt(encrypted)).toBe(key1.viewingPrivateKey)
})

test("lookupHash gives the same hash for the same value", () => {
    expect(keyCipher.lookupHash(key1.networkId)).toBe(keyCipher.lookupHash(key1.networkId))
})

test("lookupHash ignores the letter case of a hex value", () => {
    const upperCaseNetworkId = `0x${key1.networkId.slice(2).toUpperCase()}` as const

    expect(keyCipher.lookupHash(upperCaseNetworkId)).toBe(keyCipher.lookupHash(key1.networkId))
})

test("lookupHash depends on the lookup hash key", () => {
    const otherKeyCipher = createKeyCipher({
        encryptionKey: hexToBytes(`0x${"0e".repeat(32)}`),
        lookupHashKey: hexToBytes(`0x${"99".repeat(32)}`)
    })

    expect(otherKeyCipher.lookupHash(key1.networkId)).not.toBe(keyCipher.lookupHash(key1.networkId))
})

test("lookupHash never contains the value in the clear", () => {
    expect(keyCipher.lookupHash(key1.networkId)).not.toContain(key1.networkId.slice(2))
})
