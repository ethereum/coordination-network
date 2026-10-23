/**
 * Replays the committed `derivation-vectors.json`: a derivation change must
 * fail here, forcing deliberate vector regeneration.
 */

import { describe, it, expect } from "@jest/globals"
import {
    deriveKeys,
    deriveNetworkId,
    signDerivationMessage,
    KEY_DERIVATION_VERSION,
    FIXED_DOMAIN_MSG,
    DOMAIN_ACCOUNT,
    DOMAIN_AUTH,
    DOMAIN_NETWORK_ID
} from "../src"
import { secp256k1 } from "@noble/curves/secp256k1"
import type { Hex } from "../src/types"
import { signWithRecovery } from "./helpers"
import vectorsDocument from "./vectors/derivation-vectors.json"

interface KeypairFields {
    privateKey: Hex
    publicKey: Hex
    uncompressedPublicKey: Hex
}

interface Vector {
    deviceSecret: Hex
    version: string
    networkId: Hex
    memberNetworkId: Hex
    account: KeypairFields
    signature: { r: Hex; s: Hex; v: number; compact: Hex }
    spending: KeypairFields
    viewing: KeypairFields
    auth: KeypairFields
}

const { scheme, vectors } = vectorsDocument as unknown as {
    scheme: {
        version: string
        fixedDomainMsg: string
        domainAccount: string
        domainAuth: string
        domainNetworkId: string
        curve: string
        hash: string
        groupOrder: string
    }
    vectors: Vector[]
}

describe("committed derivation vectors — header", () => {
    it("echoes the current normative scheme constants", () => {
        expect(scheme.version).toBe(KEY_DERIVATION_VERSION)
        expect(scheme.fixedDomainMsg).toBe(FIXED_DOMAIN_MSG)
        expect(scheme.domainAccount).toBe(DOMAIN_ACCOUNT)
        expect(scheme.domainAuth).toBe(DOMAIN_AUTH)
        expect(scheme.domainNetworkId).toBe(DOMAIN_NETWORK_ID)
        expect(scheme.curve).toBe("secp256k1")
        expect(scheme.hash).toBe("keccak256")
        expect(scheme.groupOrder).toBe(`0x${secp256k1.CURVE.n.toString(16)}`)
    })

    it("contains a non-trivial number of vectors", () => {
        expect(vectors.length).toBeGreaterThanOrEqual(12)
    })
})

describe("committed derivation vectors — replay", () => {
    it.each(vectors.map((vector) => [vector.deviceSecret, vector] as const))(
        "reproduces every field for %s",
        (_deviceSecret, vector) => {
            const keys = deriveKeys(vector.deviceSecret)

            expect(keys.version).toBe(vector.version)
            expect(keys.networkId).toBe(vector.networkId)
            expect(keys.memberNetworkId).toBe(vector.memberNetworkId)

            expect(keys.account).toEqual(vector.account)
            expect(keys.spending).toEqual(vector.spending)
            expect(keys.viewing).toEqual(vector.viewing)
            expect(keys.auth).toEqual(vector.auth)

            // Cheap networkId path agrees with the committed value too.
            expect(deriveNetworkId(vector.deviceSecret)).toBe(vector.networkId)

            const compact = signDerivationMessage(keys.account.privateKey)
            expect(compact).toBe(vector.signature.compact)

            const signature = signWithRecovery(keys.account.privateKey)
            expect(signature.r).toBe(vector.signature.r)
            expect(signature.s).toBe(vector.signature.s)
            expect(signature.v).toBe(vector.signature.v)
            expect(signature.compact).toBe(vector.signature.compact)
            expect(`${vector.signature.r}${vector.signature.s.slice(2)}`).toBe(vector.signature.compact)
        }
    )
})
