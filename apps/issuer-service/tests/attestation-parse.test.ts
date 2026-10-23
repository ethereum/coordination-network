import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeCert } from "../src/attestation/certs"
import { parseKeyDescription } from "../src/attestation/parse"
import { CHALLENGE, TRUSTED_FIXTURES, loadFixture, loadPem } from "./attestation-fixtures"

function leafKeyDescription(chain: string[]): ArrayBuffer {
    return decodeCert(Buffer.from(chain[0], "base64")).keyDescriptions[0]
}

const LEVELS: Record<string, number> = { SOFTWARE: 0, TRUSTED_ENVIRONMENT: 1, STRONG_BOX: 2 }
const BOOT_STATES: Record<string, number> = { VERIFIED: 0, SELF_SIGNED: 1, UNVERIFIED: 2, FAILED: 3 }

for (const name of [...TRUSTED_FIXTURES, "marlin/sdk29/TEE_EC_NONE"]) {
    test(`reads ${name} as Google decodes it`, () => {
        const { chain, json } = loadFixture(name)
        const parsed = parseKeyDescription(leafKeyDescription(chain))
        const hw = json.hardwareEnforced

        assert.equal(parsed.attestationVersion, Number(json.attestationVersion))
        assert.equal(parsed.attestationSecurityLevel, LEVELS[json.attestationSecurityLevel])
        assert.equal(parsed.keyMintVersion, Number(json.keyMintVersion))
        assert.equal(parsed.keyMintSecurityLevel, LEVELS[json.keyMintSecurityLevel])
        assert.deepEqual(parsed.attestationChallenge, new Uint8Array(Buffer.from(json.attestationChallenge, "base64")))
        assert.deepEqual(
            {
                purpose: parsed.hardwareEnforced.purpose,
                algorithm: parsed.hardwareEnforced.algorithm,
                keySize: parsed.hardwareEnforced.keySize,
                digest: parsed.hardwareEnforced.digest,
                ecCurve: parsed.hardwareEnforced.ecCurve,
                noAuthRequired: parsed.hardwareEnforced.noAuthRequired,
                origin: parsed.hardwareEnforced.origin,
                rootOfTrust: parsed.hardwareEnforced.rootOfTrust
            },
            {
                purpose: hw.purposes.map(Number),
                algorithm: Number(hw.algorithms),
                keySize: Number(hw.keySize),
                digest: hw.digests?.map(Number),
                ecCurve: Number(hw.ecCurve),
                noAuthRequired: hw.noAuthRequired === true,
                origin: hw.origin === "GENERATED" ? 0 : -1,
                rootOfTrust: hw.rootOfTrust && {
                    deviceLocked: hw.rootOfTrust.deviceLocked,
                    verifiedBootState: BOOT_STATES[hw.rootOfTrust.verifiedBootState]
                }
            }
        )
        assert.equal(parsed.hardwareEnforced.allowWhileOnBody, false)
        assert.equal(parsed.hardwareEnforced.userAuthType, undefined)
        assert.equal(parsed.softwareEnforced.noAuthRequired, false)
    })
}

test("refuses Google's key description with tags out of ascending order", () => {
    assert.throws(() => parseKeyDescription(leafKeyDescription(loadPem("invalid/tags_not_in_ascending_order.pem"))))
})

// A minimal DER writer, so the cases below can encode what the library's own serializer refuses to.
function tlv(tag: number[], content: Uint8Array): Uint8Array {
    const length =
        content.length < 0x80
            ? [content.length]
            : content.length < 0x100
              ? [0x81, content.length]
              : [0x82, content.length >> 8, content.length & 0xff]
    return Uint8Array.from([...tag, ...length, ...content])
}
const concat = (items: Uint8Array[]) => Uint8Array.from(items.flatMap((item) => [...item]))
const integer = (value: number) => tlv([0x02], Uint8Array.from([value]))
const enumerated = (value: number) => tlv([0x0a], Uint8Array.from([value]))
const octets = (bytes: Uint8Array) => tlv([0x04], bytes)
const nothing = () => tlv([0x05], new Uint8Array())
const sequence = (...items: Uint8Array[]) => tlv([0x30], concat(items))
const set = (...items: Uint8Array[]) => tlv([0x31], concat(items))
function tagged(tagNumber: number, inner: Uint8Array): Uint8Array {
    const tag =
        tagNumber < 31
            ? [0xa0 | tagNumber]
            : [0xbf, ...(tagNumber >= 128 ? [0x80 | (tagNumber >> 7)] : []), tagNumber & 0x7f]
    return tlv(tag, inner)
}

const PURPOSE_SIGN = tagged(1, set(integer(2)))
const ALGORITHM_EC = tagged(2, integer(3))
const NO_AUTH_REQUIRED = tagged(503, nothing())

function keyDescription(hardware: Uint8Array[], software: Uint8Array[] = [], trailing: Uint8Array[] = []) {
    return sequence(
        integer(100),
        enumerated(1),
        integer(100),
        enumerated(1),
        octets(CHALLENGE),
        octets(new Uint8Array()),
        sequence(...software),
        sequence(...hardware),
        ...trailing
    )
}

test("the DER writer above encodes what the parser accepts", () => {
    const parsed = parseKeyDescription(keyDescription([PURPOSE_SIGN, ALGORITHM_EC, NO_AUTH_REQUIRED]))
    assert.deepEqual(parsed.hardwareEnforced.purpose, [2])
    assert.equal(parsed.hardwareEnforced.algorithm, 3)
    assert.equal(parsed.hardwareEnforced.noAuthRequired, true)
    assert.deepEqual(parsed.attestationChallenge, CHALLENGE)
})

test("a NULL tag reads as present only when it is there", () => {
    const parsed = parseKeyDescription(keyDescription([ALGORITHM_EC], [NO_AUTH_REQUIRED]))
    assert.equal(parsed.hardwareEnforced.noAuthRequired, false)
    assert.equal(parsed.softwareEnforced.noAuthRequired, true)
})

for (const [name, der] of [
    ["an unknown tag", keyDescription([ALGORITHM_EC, tagged(799, nothing())])],
    ["an unknown tag between known ones", keyDescription([PURPOSE_SIGN, tagged(4, nothing()), ALGORITHM_EC])],
    ["a duplicate tag", keyDescription([ALGORITHM_EC, ALGORITHM_EC])],
    ["tags out of order", keyDescription([ALGORITHM_EC, PURPOSE_SIGN])],
    ["an untagged item in an authorization list", keyDescription([ALGORITHM_EC, integer(5)])],
    ["a ninth top-level field", keyDescription([ALGORITHM_EC], [], [integer(1)])],
    ["trailing bytes", concat([keyDescription([ALGORITHM_EC]), nothing()])],
    ["a non-minimal integer", keyDescription([tagged(2, tlv([0x02], Uint8Array.from([0, 0, 0, 3])))])],
    ["a truncated encoding", keyDescription([ALGORITHM_EC]).subarray(0, 20)]
] as const) {
    test(`refuses ${name}`, () => {
        assert.throws(() => parseKeyDescription(der))
    })
}
