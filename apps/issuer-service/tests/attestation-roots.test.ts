import assert from "node:assert/strict"
import { X509Certificate, createHash } from "node:crypto"
import { test } from "node:test"
import { GOOGLE_ATTESTATION_ROOTS } from "../src/attestation"
import { loadPem } from "./attestation-fixtures"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function rootSpki(name: string): Buffer {
    const chain = loadPem(`${name}.pem`)
    return new X509Certificate(Buffer.from(chain[chain.length - 1], "base64")).publicKey.export({
        type: "spki",
        format: "der"
    })
}

test("pins the SPKI of Google's RSA root and of Key Attestation CA1", () => {
    assert.deepEqual(
        GOOGLE_ATTESTATION_ROOTS.map(({ spki, factory }) => ({ hash: sha256(spki), factory })),
        [
            { hash: "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae", factory: true },
            { hash: "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec", factory: false }
        ]
    )
})

test("the 2016, 2019 and 2022 RSA root certificates all carry the pinned RSA key", () => {
    const [rsa] = GOOGLE_ATTESTATION_ROOTS
    for (const name of [
        "walleye/sdk27/TEE_EC_NONE",
        "akita/sdk34/TEE_EC_NONE",
        "invalid/tags_not_in_ascending_order"
    ]) {
        assert.ok(rootSpki(name).equals(rsa.spki), name)
    }
})

test("the 2026 chains end in the pinned P-384 root", () => {
    const [, p384] = GOOGLE_ATTESTATION_ROOTS
    for (const name of ["tegu/sdk36/SB_EC_2026_ROOT", "tegu/sdk36/TEE_EC_2026_ROOT", "frankel/sdk37/TEE_EC_2026"]) {
        assert.ok(rootSpki(name).equals(p384.spki), name)
    }
})

test("the software attestation root is not pinned", () => {
    const software = rootSpki("marlin/sdk29/TEE_EC_NONE")
    assert.ok(GOOGLE_ATTESTATION_ROOTS.every(({ spki }) => !spki.equals(software)))
})
