import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeCert } from "../src/attestation/certs"
import { loadFixture } from "./attestation-fixtures"

const der = (b64: string) => Buffer.from(b64, "base64")

test("reads an RKP chain's serials as lowercase hex without leading zeros", () => {
    const { chain } = loadFixture("akita/sdk34/TEE_EC_NONE")
    assert.deepEqual(
        chain.map((cert) => decodeCert(der(cert)).serialHex),
        [
            "1",
            "4f47dffaecc3f58346fb7815514e0dcc",
            "bfc61f12db0cce5bc16832d05e052e488cb284",
            "388266760658996860e",
            "d50ff25ba3f2d6b3"
        ]
    )
})

test("reads subject attributes by OID", () => {
    const { chain } = loadFixture("akita/sdk34/TEE_EC_NONE")
    const droidCa2 = decodeCert(der(chain[3]))
    assert.deepEqual(droidCa2.subject.get("2.5.4.3"), ["Droid CA2"])
    assert.deepEqual(droidCa2.subject.get("2.5.4.10"), ["Google LLC"])
    assert.equal(droidCa2.subject.get("2.5.4.5"), undefined)

    const factoryIntermediate = decodeCert(der(loadFixture("walleye/sdk27/TEE_EC_NONE").chain[2]))
    assert.deepEqual(factoryIntermediate.subject.get("2.5.4.5"), ["87f4514475ba0a2b"])
})

test("finds the key description on the leaf only", () => {
    const { chain } = loadFixture("caiman/sdk36/TEE_EC_RKP")
    assert.deepEqual(
        chain.map((cert) => decodeCert(der(cert)).keyDescriptions.length),
        [1, 0, 0, 0, 0]
    )
})

test("refuses anything but exactly one DER certificate", () => {
    const leaf = der(loadFixture("akita/sdk34/TEE_EC_NONE").chain[0])
    const pem = `-----BEGIN CERTIFICATE-----\n${leaf.toString("base64")}\n-----END CERTIFICATE-----\n`
    for (const bytes of [
        Buffer.from(pem),
        Buffer.concat([leaf, Buffer.from([0x05, 0x00])]),
        leaf.subarray(0, leaf.length - 1),
        Buffer.from("not a certificate")
    ]) {
        assert.throws(() => decodeCert(bytes))
    }
})
