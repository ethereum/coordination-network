import { base64ToBytes, bytesToBase64 } from "@coordination-network/expo-identity-keystore"
import type { TestContext } from "../context"
import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

const KEYSTORE_ALIAS = "testbed-attestation"

/** The wallet's `DEVICE_ATTESTATION_CHALLENGE`; the testbed doesn't depend on `credential`. */
const ATTESTATION_CHALLENGE = "urn:cn:device-attestation:v1"

interface Tlv {
    tag: number
    value: Uint8Array
    end: number
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
    const tag = bytes[offset]
    let length = bytes[offset + 1]
    let start = offset + 2

    if (length & 0x80) {
        const lengthBytes = length & 0x7f
        length = 0
        for (let i = 0; i < lengthBytes; i++) {
            length = length * 256 + bytes[start + i]
        }
        start += lengthBytes
    }

    return { tag, value: bytes.subarray(start, start + length), end: start + length }
}

function children(bytes: Uint8Array): Tlv[] {
    const entries: Tlv[] = []
    for (let offset = 0; offset < bytes.length;) {
        const entry = readTlv(bytes, offset)
        entries.push(entry)
        offset = entry.end
    }
    return entries
}

/** The text values of a certificate's subject name, e.g. `Android Keystore Key`. The serial is never read. */
function subjectText(certificate: Uint8Array): string {
    const tbs = children(readTlv(certificate, 0).value)[0]
    const fields = children(tbs.value)
    // After the optional [0] version: serial, signature algorithm, issuer, validity, subject.
    const subject = fields[fields[0].tag === 0xa0 ? 5 : 4]

    return children(subject.value)
        .flatMap((rdn) => children(rdn.value))
        .map((attribute) => new TextDecoder().decode(children(attribute.value)[1].value))
        .join(", ")
}

/**
 * The signing key as the wallet generates it, with an attestation challenge. The issuer verifies
 * what the chain says; this case checks the device produces one of at least a leaf and its issuer,
 * and prints the chain length and the leaf subject only.
 */
export const keyAttestationCase: TestCase = {
    id: "key-attestation",
    name: "device key attestation (hardware Keystore)",
    description: "A signing key generated with a challenge carries an attestation chain of 2+ certificates",
    group: "device-key",
    tier: "keystore",
    async run(ctx: TestContext): Promise<TestDetail> {
        const start = performance.now()
        const checks: Check[] = []

        const { keystore } = ctx

        if (!keystore) {
            return finish(start, [check("Keystore module available", false, "requires dev build")])
        }

        try {
            await keystore.deleteKey(KEYSTORE_ALIAS)

            const { securityLevel } = await keystore.generateKey(KEYSTORE_ALIAS, {
                purpose: "sign",
                attestationChallenge: bytesToBase64(new TextEncoder().encode(ATTESTATION_CHALLENGE))
            })
            checks.push(check("signing key generated with a challenge", true, `securityLevel ${securityLevel}`))

            const chain = await keystore.getAttestationChain(KEYSTORE_ALIAS)
            checks.push(
                check(
                    "attestation chain has at least 2 certificates",
                    chain.length >= 2,
                    `${chain.length} certificates`
                )
            )

            if (chain.length > 0) {
                checks.push(check("leaf subject", true, subjectText(base64ToBytes(chain[0]))))
            }

            await keystore.deleteKey(KEYSTORE_ALIAS)

            return finish(start, checks)
        } catch (error) {
            return finish(start, [...checks, check("keystore operation", false, errorMessage(error))])
        }
    }
}
