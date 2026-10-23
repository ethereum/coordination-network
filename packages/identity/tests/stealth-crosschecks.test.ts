/**
 * External-implementation cross-checks for the functions in
 * `src/stealthAddresses/`.
 *
 * - `deriveStealthKeys` is checked against FluidKey's
 *   `generateKeysFromSignature` (the pre-ERC convention it implements).
 * - Everything else is checked against ScopeLift's `stealth-address-sdk`,
 *   the ERC-5564 authors' TypeScript implementation.
 *
 * Not cross-checkable:
 * - `computeSharedSecret` — the SDK has an identical internal function but
 *   does not export it. It is proven transitively: `generateStealthAddress`
 *   below runs the SDK's full pipeline (their ECDH + their hash) against
 *   ours, so any differing byte in the hashed secret changes the address.
 * - `encodeMetaStealthAddressUri` / `validateMetaStealthAddress` — the SDK
 *   consumes our URI form in every test here (`stealthMetaAddressURI`).
 * - `generateEphemeralKey` — random output, nothing deterministic to compare.
 *
 * The deep `dist/utils/crypto` import avoids the SDK barrel, which drags in
 * subgraph/RPC modules and a `graphql` peer dependency the crypto does not
 * need. The SDK is bundler-style ESM, transformed to CJS via the
 * `transformIgnorePatterns` exception in the root jest config.
 */

import { describe, it, expect } from "@jest/globals"
import {
    generateStealthAddress as scopeliftGenerateStealthAddress,
    computeStealthKey as scopeliftComputeStealthKey,
    checkStealthAddress as scopeliftCheckStealthAddress,
    getStealthPublicKey as scopeliftGetStealthPublicKey,
    publicKeyToAddress as scopeliftPublicKeyToAddress,
    VALID_SCHEME_ID
} from "@scopelift/stealth-address-sdk/dist/utils/crypto"
import {
    parseKeysFromStealthMetaAddress as scopeliftParseKeysFromStealthMetaAddress,
    getHashedSharedSecret as scopeliftGetHashedSharedSecret
} from "@scopelift/stealth-address-sdk/dist/utils/crypto"
import { secp256k1 } from "@noble/curves/secp256k1"
import scopeliftGenerateStealthMetaAddressFromKeys from "@scopelift/stealth-address-sdk/dist/utils/helpers/generateStealthMetaAddressFromKeys"
import { generateKeysFromSignature } from "@fluidkey/stealth-account-kit"

import { deriveKeys, deriveAccountKeypair, signDerivationMessage, deriveStealthKeys } from "../src"
import type { Hex, Secp256k1Keypair } from "../src/types"
import { bytesToHex, hexToBytes } from "../src/bytes"
import { buildAnnouncement } from "../src/stealthAddresses/buildAnnouncement"
import { computeSharedSecret } from "../src/stealthAddresses/computeSharedSecret"
import { getViewTag } from "../src/stealthAddresses/getViewTag"
import { getStealthPublicKey } from "../src/stealthAddresses/getStealthPublicKey"
import { publicKeyToAddress } from "../src/stealthAddresses/publicKeyToAddress"
import { generateStealthAddress } from "../src/stealthAddresses/generateStealthAddress"
import { generateStealthPrivateKey } from "../src/stealthAddresses/generateStealthPrivateKey"
import { checkStealthAddress } from "../src/stealthAddresses/checkStealthAddress"
import { encodeMetaStealthAddress } from "../src/stealthAddresses/encodeMetaStealthAddress"
import { decodeMetaStealthAddress } from "../src/stealthAddresses/decodeMetaStealthAddress"
import { seededSecret, signWithRecovery, fluidkeySignatureHex } from "./helpers"
import { seededEphemeralKey } from "./stealthAddresses/helpers"

const SEED_INDICES = [0, 1, 2, 3, 4, 5, 6, 7]

// Filled at module scope: it.each() collects its cases before beforeAll runs.
const KEY_PAIRS: { spending: Secp256k1Keypair; viewing: Secp256k1Keypair; ephemeral: Secp256k1Keypair }[] =
    SEED_INDICES.map((index) => {
        const { spending, viewing } = deriveKeys(seededSecret(index))
        return { spending, viewing, ephemeral: seededEphemeralKey(index) }
    })

function scopeliftAnnouncement({ spending, viewing, ephemeral }: (typeof KEY_PAIRS)[number]) {
    return scopeliftGenerateStealthAddress({
        stealthMetaAddressURI: `st:eth:0x${spending.publicKey.slice(2)}${viewing.publicKey.slice(2)}`,
        schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
        ephemeralPrivateKey: hexToBytes(ephemeral.privateKey)
    })
}

describe("stealth-address cross-checks", () => {
    it.each(KEY_PAIRS)("buildAnnouncement is accepted by ScopeLift's checkStealthAddress", (keyPairs) => {
        const { spending, viewing } = keyPairs

        const announcement = buildAnnouncement({
            metaStealthAddress: encodeMetaStealthAddress({
                spendingPublicKey: spending.publicKey,
                viewingPublicKey: viewing.publicKey
            })
        })

        // Ephemeral key generation is random, so there is no fixed output to compare.
        // We check that announcement is valid according to ScopeLift's scopeliftCheckStealthAddress.
        expect(
            scopeliftCheckStealthAddress({
                userStealthAddress: announcement.stealthAddress,
                ephemeralPublicKey: announcement.ephemeralPublicKey,
                viewTag: announcement.metadata,
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey,
                schemeId: VALID_SCHEME_ID.SCHEME_ID_1
            })
        ).toBe(true)
    })

    it.each(KEY_PAIRS)("checkStealthAddress matches ScopeLift's checkStealthAddress", (keyPairs) => {
        const { spending, viewing, ephemeral } = keyPairs

        const scopelift = scopeliftAnnouncement(keyPairs)

        // Our scanner recognises the SDK's announcement...
        expect(
            checkStealthAddress({
                stealthAddress: scopelift.stealthAddress,
                ephemeralPublicKey: scopelift.ephemeralPublicKey as Hex,
                viewTag: parseInt(scopelift.viewTag, 16),
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(true)

        // ...and the SDK's scanner recognises ours.
        const stealthAddress = generateStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey,
            ephemeralPrivateKey: ephemeral.privateKey
        })
        const viewTag = getViewTag(
            computeSharedSecret({ privateKey: ephemeral.privateKey, publicKey: viewing.publicKey })
        )

        expect(
            scopeliftCheckStealthAddress({
                userStealthAddress: stealthAddress,
                ephemeralPublicKey: ephemeral.publicKey,
                viewTag: `0x${viewTag.toString(16).padStart(2, "0")}`,
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey,
                schemeId: VALID_SCHEME_ID.SCHEME_ID_1
            })
        ).toBe(true)
    })

    it.each(KEY_PAIRS)("computeSharedSecret's hash step matches ScopeLift's getHashedSharedSecret", (keyPairs) => {
        const { viewing, ephemeral } = keyPairs

        const sharedSecretPoint = secp256k1.getSharedSecret(
            hexToBytes(ephemeral.privateKey),
            hexToBytes(viewing.publicKey),
            true
        )

        const scopeliftHash = scopeliftGetHashedSharedSecret({
            sharedSecret: sharedSecretPoint,
            schemeId: VALID_SCHEME_ID.SCHEME_ID_1
        })

        const hashedSharedSecret = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })

        expect(bytesToHex(hashedSharedSecret)).toBe(scopeliftHash.toLowerCase())
    })

    it.each(KEY_PAIRS)("decodeMetaStealthAddress matches ScopeLift's parseKeysFromStealthMetaAddress", (keyPairs) => {
        const { spending, viewing } = keyPairs

        const meta = encodeMetaStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })

        const scopelift = scopeliftParseKeysFromStealthMetaAddress({
            stealthMetaAddress: meta,
            schemeId: VALID_SCHEME_ID.SCHEME_ID_1
        })

        const decoded = decodeMetaStealthAddress(meta)

        expect(decoded.spendingPublicKey).toBe(bytesToHex(scopelift.spendingPublicKey))
        expect(decoded.viewingPublicKey).toBe(bytesToHex(scopelift.viewingPublicKey))
    })

    it.each(SEED_INDICES)("deriveStealthKeys matches FluidKey's generateKeysFromSignature", (index) => {
        const account = deriveAccountKeypair(seededSecret(index))
        const compact = signDerivationMessage(account.privateKey)
        const fluidkeySignature = fluidkeySignatureHex(signWithRecovery(account.privateKey))

        const fluidkey = generateKeysFromSignature(fluidkeySignature)
        const { spending, viewing } = deriveStealthKeys(compact)

        expect(spending.privateKey).toBe(fluidkey.spendingPrivateKey)
        expect(viewing.privateKey).toBe(fluidkey.viewingPrivateKey)
    })

    it.each(KEY_PAIRS)(
        "encodeMetaStealthAddress matches ScopeLift's generateStealthMetaAddressFromKeys",
        (keyPairs) => {
            const { spending, viewing } = keyPairs

            const scopeliftMeta = scopeliftGenerateStealthMetaAddressFromKeys({
                spendingPublicKey: spending.publicKey,
                viewingPublicKey: viewing.publicKey
            })

            const meta = encodeMetaStealthAddress({
                spendingPublicKey: spending.publicKey,
                viewingPublicKey: viewing.publicKey
            })

            expect(meta).toBe(scopeliftMeta.toLowerCase())
        }
    )

    it.each(KEY_PAIRS)("generateStealthAddress matches ScopeLift's generateStealthAddress", (keyPairs) => {
        const { spending, viewing, ephemeral } = keyPairs

        const scopelift = scopeliftAnnouncement(keyPairs)

        const stealthAddress = generateStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey,
            ephemeralPrivateKey: ephemeral.privateKey
        })

        expect(stealthAddress).toBe(scopelift.stealthAddress.toLowerCase())
    })

    it.each(KEY_PAIRS)("generateStealthPrivateKey matches ScopeLift's computeStealthKey", (keyPairs) => {
        const { spending, viewing, ephemeral } = keyPairs

        const scopeliftKey = scopeliftComputeStealthKey({
            schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
            ephemeralPublicKey: ephemeral.publicKey as Hex,
            viewingPrivateKey: viewing.privateKey,
            spendingPrivateKey: spending.privateKey
        })

        const stealthPrivateKey = generateStealthPrivateKey({
            ephemeralPublicKey: ephemeral.publicKey,
            viewingPrivateKey: viewing.privateKey,
            spendingPrivateKey: spending.privateKey
        })

        expect(stealthPrivateKey).toBe(scopeliftKey.toLowerCase())
    })

    it.each(KEY_PAIRS)("getStealthPublicKey matches ScopeLift's getStealthPublicKey", (keyPairs) => {
        const { spending, viewing, ephemeral } = keyPairs

        const hashedSharedSecret = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })

        const scopeliftKey = scopeliftGetStealthPublicKey({
            spendingPublicKey: hexToBytes(spending.publicKey),
            hashedSharedSecret: bytesToHex(hashedSharedSecret),
            schemeId: VALID_SCHEME_ID.SCHEME_ID_1
        })

        const stealthPublicKey = getStealthPublicKey({
            spendingPublicKey: spending.publicKey,
            hashedSharedSecret
        })

        expect(bytesToHex(stealthPublicKey)).toBe(bytesToHex(scopeliftKey))
    })

    it.each(KEY_PAIRS)("getViewTag matches ScopeLift's viewTag", (keyPairs) => {
        const { viewing, ephemeral } = keyPairs

        const scopelift = scopeliftAnnouncement(keyPairs)
        const hashedSharedSecret = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })

        // The SDK returns the tag as a 0x-prefixed single-byte hex string.
        expect(getViewTag(hashedSharedSecret)).toBe(parseInt(scopelift.viewTag, 16))
    })

    it.each(KEY_PAIRS)("publicKeyToAddress matches ScopeLift's publicKeyToAddress", (keyPairs) => {
        const { spending, viewing, ephemeral } = keyPairs

        const hashedSharedSecret = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })
        const stealthPublicKey = getStealthPublicKey({
            spendingPublicKey: spending.publicKey,
            hashedSharedSecret
        })

        const scopeliftAddress = scopeliftPublicKeyToAddress({
            publicKey: stealthPublicKey,
            schemeId: VALID_SCHEME_ID.SCHEME_ID_1
        })

        expect(publicKeyToAddress(stealthPublicKey)).toBe(scopeliftAddress.toLowerCase())
    })
})
