import assert from "node:assert/strict"
import { test } from "node:test"
import { p256 } from "@noble/curves/nist.js"
import { GOOGLE_ATTESTATION_ROOTS } from "../src/attestation"
import { decodeCert } from "../src/attestation/certs"
import { parseStatusList } from "../src/attestation/status-list"
import { verifyChain, type ChainInput } from "../src/attestation/verify-chain"
import {
    DAY,
    TRUSTED_FIXTURES,
    loadFixture,
    loadPem,
    mintChain,
    testRoot,
    withUnloadableKey
} from "./attestation-fixtures"

const NO_REVOCATIONS: ReadonlySet<string> = new Set()
const OTHER_KEY_XY = p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1)

function checkFixture(name: string, overrides: Partial<ChainInput> = {}) {
    const fixture = loadFixture(name)
    return verifyChain({
        chain: fixture.chain,
        roots: GOOGLE_ATTESTATION_ROOTS,
        revokedSerials: NO_REVOCATIONS,
        now: fixture.createdAt,
        confirmationKeyXY: fixture.leafKeyXY,
        ...overrides
    })
}

const EXPECTED: Record<string, { provisioning: "rkp" | "factory"; securityLevel?: string }> = {
    "walleye/sdk27/TEE_EC_NONE": { provisioning: "factory" },
    "blueline/sdk28/TEE_EC_NONE": { provisioning: "factory" },
    "sony-xperia10-iii/sdk33/TEE_EC": { provisioning: "factory" },
    "akita/sdk34/TEE_EC_NONE": { provisioning: "rkp", securityLevel: "TRUSTED_ENVIRONMENT" },
    "caiman/sdk36/TEE_EC_RKP": { provisioning: "rkp", securityLevel: "TRUSTED_ENVIRONMENT" },
    "caiman/sdk36/SB_EC_RKP": { provisioning: "rkp", securityLevel: "STRONGBOX" },
    "tegu/sdk36/SB_EC_2026_ROOT": { provisioning: "rkp", securityLevel: "STRONGBOX" },
    "tegu/sdk36/TEE_EC_2026_ROOT": { provisioning: "rkp", securityLevel: "TRUSTED_ENVIRONMENT" },
    "frankel/sdk37/TEE_EC_2026": { provisioning: "rkp", securityLevel: "TRUSTED_ENVIRONMENT" }
}

for (const name of TRUSTED_FIXTURES) {
    test(`validates ${name} at its creation time`, () => {
        const result = checkFixture(name)
        assert.ok(result.ok, JSON.stringify(result))
        assert.deepEqual(
            { provisioning: result.provisioning, securityLevel: result.securityLevel },
            { securityLevel: undefined, ...EXPECTED[name] }
        )
    })
}

// The wallet sends the chain made at key generation with every issuance, long after an RKP
// attestation cert's week or two of validity.
for (const name of TRUSTED_FIXTURES.filter((name) => EXPECTED[name].provisioning === "rkp")) {
    test(`validates ${name} 30 and 120 days after its key was created`, () => {
        const { createdAt } = loadFixture(name)
        for (const days of [30, 120]) {
            const result = checkFixture(name, { now: createdAt + days * DAY })
            assert.ok(result.ok, `${days} days: ${JSON.stringify(result)}`)
        }
    })
}

for (const name of TRUSTED_FIXTURES.filter((name) => EXPECTED[name].provisioning === "factory")) {
    test(`validates ${name} 90 days after its key was created`, () => {
        const { createdAt } = loadFixture(name)
        const result = checkFixture(name, { now: createdAt + 90 * DAY })
        assert.ok(result.ok, JSON.stringify(result))
    })
}

test("refuses a chain that ends in the software attestation root", () => {
    assert.deepEqual(checkFixture("marlin/sdk29/TEE_EC_NONE"), { ok: false, reason: "UNTRUSTED_ROOT", certIndex: 2 })
})

test("refuses Google's chain whose leaf was edited after signing", () => {
    const chain = loadPem("invalid/tags_not_in_ascending_order.pem")
    const result = verifyChain({
        chain,
        roots: GOOGLE_ATTESTATION_ROOTS,
        revokedSerials: NO_REVOCATIONS,
        now: Date.parse("2024-01-01"),
        confirmationKeyXY: OTHER_KEY_XY
    })
    assert.deepEqual(result, { ok: false, reason: "INVALID_SIGNATURE", certIndex: 0 })
})

test("refuses a chain with a revoked certificate, matching serials as the status list writes them", () => {
    const { chain } = loadFixture("walleye/sdk27/TEE_EC_NONE")
    const attestationSerial = decodeCert(Buffer.from(chain[1], "base64")).serialHex
    assert.equal(attestationSerial, "11787315027986020010")
    assert.deepEqual(checkFixture("walleye/sdk27/TEE_EC_NONE", { revokedSerials: new Set([attestationSerial]) }), {
        ok: false,
        reason: "CERT_REVOKED",
        certIndex: 1
    })
    // The intermediate's DER serial has a leading zero byte; the list key does not.
    assert.deepEqual(checkFixture("walleye/sdk27/TEE_EC_NONE", { revokedSerials: new Set(["3882667606589968575"]) }), {
        ok: false,
        reason: "CERT_REVOKED",
        certIndex: 2
    })
})

test("revokes a factory chain whether the status list writes its serial in decimal or in hex", () => {
    const listing = (key: string) => parseStatusList({ entries: { [key]: { status: "REVOKED" } } })
    // walleye's attestation cert serial is 0x11787315027986020010: all digits even in hex.
    for (const key of ["82502132034638950039568", "11787315027986020010"]) {
        assert.deepEqual(checkFixture("walleye/sdk27/TEE_EC_NONE", { revokedSerials: listing(key) }), {
            ok: false,
            reason: "CERT_REVOKED",
            certIndex: 1
        })
    }
})

test("an expired factory intermediate passes, and a not-yet-valid one fails at now", () => {
    // walleye's intermediates expired in May 2026, before its leaf's creation time.
    assert.ok(checkFixture("walleye/sdk27/TEE_EC_NONE").ok)
    assert.ok(checkFixture("walleye/sdk27/TEE_EC_NONE", { now: Date.parse("2030-01-01") }).ok)
    assert.deepEqual(checkFixture("walleye/sdk27/TEE_EC_NONE", { now: Date.parse("2016-01-01") }), {
        ok: false,
        reason: "CERT_NOT_YET_VALID",
        certIndex: 2
    })
})

test("judges a real RKP chain at now when its key claims a later creation time", () => {
    // A phone clock two weeks fast: akita's attestation cert starts 16 days before the claimed time.
    const { createdAt } = loadFixture("akita/sdk34/TEE_EC_NONE")
    const result = checkFixture("akita/sdk34/TEE_EC_NONE", { now: createdAt - 14 * DAY })
    assert.ok(result.ok, JSON.stringify(result))
})

test("ignores the root's own validity", () => {
    // blueline's 2016 root certificate expired in May 2026; its intermediates run to 2028.
    assert.ok(checkFixture("blueline/sdk28/TEE_EC_NONE", { now: Date.parse("2027-01-01") }).ok)
})

test("refuses a leaf that certifies some other key", () => {
    assert.deepEqual(checkFixture("caiman/sdk36/TEE_EC_RKP", { confirmationKeyXY: OTHER_KEY_XY }), {
        ok: false,
        reason: "LEAF_KEY_MISMATCH",
        certIndex: 0
    })
})

test("bounds the chain before decoding it", () => {
    const { chain } = loadFixture("akita/sdk34/TEE_EC_NONE")
    assert.deepEqual(checkFixture("akita/sdk34/TEE_EC_NONE", { chain: [chain[0], ...chain] }), {
        ok: false,
        reason: "CHAIN_SIZE"
    })
    const oversized = Buffer.alloc(16 * 1024 + 1).toString("base64")
    assert.deepEqual(checkFixture("akita/sdk34/TEE_EC_NONE", { chain: [oversized, ...chain.slice(1)] }), {
        ok: false,
        reason: "CHAIN_SIZE",
        certIndex: 0
    })
})

test("refuses an undecodable certificate", () => {
    const { chain } = loadFixture("akita/sdk34/TEE_EC_NONE")
    assert.deepEqual(checkFixture("akita/sdk34/TEE_EC_NONE", { chain: [chain[0], "AAAA", ...chain.slice(2)] }), {
        ok: false,
        reason: "CERT_MALFORMED",
        certIndex: 1
    })
})

test("refuses a pinned-root chain shorter than four certificates", () => {
    const { chain } = loadFixture("akita/sdk34/TEE_EC_NONE")
    assert.deepEqual(checkFixture("akita/sdk34/TEE_EC_NONE", { chain: [chain[0], chain[3], chain[4]] }), {
        ok: false,
        reason: "CHAIN_SIZE"
    })
})

test("an RKP chain needs five certificates and a factory chain four", () => {
    const akita = loadFixture("akita/sdk34/TEE_EC_NONE").chain
    assert.deepEqual(checkFixture("akita/sdk34/TEE_EC_NONE", { chain: [akita[0], akita[1], akita[3], akita[4]] }), {
        ok: false,
        reason: "PROVISIONING_MISMATCH"
    })
    const walleye = loadFixture("walleye/sdk27/TEE_EC_NONE").chain
    assert.deepEqual(
        checkFixture("walleye/sdk27/TEE_EC_NONE", {
            chain: [walleye[0], walleye[1], walleye[2], walleye[2], walleye[3]]
        }),
        { ok: false, reason: "PROVISIONING_MISMATCH" }
    )
})

test("refuses mismatched issuer and subject names", () => {
    const caiman = loadFixture("caiman/sdk36/TEE_EC_RKP")
    const tegu = loadFixture("tegu/sdk36/TEE_EC_2026_ROOT")
    assert.deepEqual(
        checkFixture("tegu/sdk36/TEE_EC_2026_ROOT", { chain: [caiman.chain[0], ...tegu.chain.slice(1)] }),
        { ok: false, reason: "NAME_CHAINING", certIndex: 0 }
    )
})

const KEY_XY = p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1)

async function checkMinted(
    options: Parameters<typeof mintChain>[0],
    revoked: (serials: string[]) => string[] = () => []
) {
    const { chain, serials } = await mintChain(options)
    return verifyChain({
        chain,
        roots: [await testRoot(), ...GOOGLE_ATTESTATION_ROOTS],
        revokedSerials: new Set(revoked(serials)),
        now: Date.now(),
        confirmationKeyXY: KEY_XY
    })
}

test("validates a minted RKP chain under the injected root", async () => {
    const result = await checkMinted({ confirmationKeyXY: KEY_XY })
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(result.provisioning, "rkp")
    assert.equal(result.securityLevel, "TRUSTED_ENVIRONMENT")
})

test("a leaf hung below an attested key fails extension placement", async () => {
    assert.deepEqual(await checkMinted({ confirmationKeyXY: KEY_XY, hangBelowAttestedKey: true }), {
        ok: false,
        reason: "EXTENSION_MISPLACED",
        certIndex: 1
    })
})

test("refuses a leaf without a key description", async () => {
    assert.deepEqual(await checkMinted({ confirmationKeyXY: KEY_XY, omitKeyDescription: true }), {
        ok: false,
        reason: "EXTENSION_MISSING",
        certIndex: 0
    })
})

test("refuses a chain with a revoked intermediate", async () => {
    assert.deepEqual(await checkMinted({ confirmationKeyXY: KEY_XY }, (serials) => [serials[2]]), {
        ok: false,
        reason: "CERT_REVOKED",
        certIndex: 2
    })
})

test("refuses a certificate whose signature does not verify", async () => {
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY })
    const leaf = Buffer.from(chain[0], "base64")
    leaf[leaf.length - 1] ^= 1
    const result = verifyChain({
        chain: [leaf.toString("base64"), ...chain.slice(1)],
        roots: [await testRoot()],
        revokedSerials: NO_REVOCATIONS,
        now: Date.now(),
        confirmationKeyXY: KEY_XY
    })
    assert.deepEqual(result, { ok: false, reason: "INVALID_SIGNATURE", certIndex: 0 })
})

test("refuses a chain whose provisioning type it cannot tell", async () => {
    assert.deepEqual(await checkMinted({ confirmationKeyXY: KEY_XY, intermediateName: "CN=Droid CA2, O=Not Google" }), {
        ok: false,
        reason: "UNKNOWN_PROVISIONING"
    })
})

test("a factory chain must end in the RSA root", async () => {
    assert.deepEqual(await checkMinted({ confirmationKeyXY: KEY_XY, factory: true }), {
        ok: false,
        reason: "PROVISIONING_MISMATCH"
    })
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY, factory: true })
    const asFactoryRoot = verifyChain({
        chain,
        roots: [await testRoot(true)],
        revokedSerials: NO_REVOCATIONS,
        now: Date.now(),
        confirmationKeyXY: KEY_XY
    })
    assert.deepEqual(asFactoryRoot.ok && asFactoryRoot.provisioning, "factory")
})

test("reads a StrongBox claim from an RKP attestation cert", async () => {
    const result = await checkMinted({ confirmationKeyXY: KEY_XY, attestationOrganization: "StrongBox" })
    assert.deepEqual(result.ok && result.securityLevel, "STRONGBOX")
    const other = await checkMinted({ confirmationKeyXY: KEY_XY, attestationOrganization: "Something" })
    assert.deepEqual(other.ok && other.securityLevel, "SOFTWARE")
})

test("judges RKP expiry at the earlier of the key's creation time and now", async () => {
    const now = Date.now()
    const attestationValidity = { notBefore: new Date(now - 20 * DAY), notAfter: new Date(now - 10 * DAY) }
    for (const createdAt of [now - 15 * DAY, now - 25 * DAY]) {
        const result = await checkMinted({ confirmationKeyXY: KEY_XY, attestationValidity, createdAt })
        assert.ok(result.ok, JSON.stringify(result))
    }
    for (const createdAt of [now - 5 * DAY, now + DAY]) {
        assert.deepEqual(await checkMinted({ confirmationKeyXY: KEY_XY, attestationValidity, createdAt }), {
            ok: false,
            reason: "CERT_EXPIRED",
            certIndex: 1
        })
    }
})

test("accepts an RKP key from a phone clock three weeks fast, issued at the real key time", async () => {
    const now = Date.now()
    const result = await checkMinted({
        confirmationKeyXY: KEY_XY,
        attestationValidity: { notBefore: new Date(now - 2 * DAY), notAfter: new Date(now + 7 * DAY) },
        createdAt: now + 21 * DAY
    })
    assert.ok(result.ok, JSON.stringify(result))
})

test("accepts an RKP key created a day before Droid CA3's notBefore", async () => {
    // Minted intermediates start 365 days back.
    const result = await checkMinted({ confirmationKeyXY: KEY_XY, createdAt: Date.now() - 366 * DAY })
    assert.ok(result.ok, JSON.stringify(result))
})

test("refuses an RKP intermediate not yet valid at now, whatever the key's creation time", async () => {
    const now = Date.now()
    assert.deepEqual(
        await checkMinted({
            confirmationKeyXY: KEY_XY,
            attestationValidity: { notBefore: new Date(now + DAY), notAfter: new Date(now + 10 * DAY) },
            createdAt: now + 2 * DAY
        }),
        { ok: false, reason: "CERT_NOT_YET_VALID", certIndex: 1 }
    )
})

test("judges a chain without a creation time at now", async () => {
    const now = Date.now()
    assert.ok((await checkMinted({ confirmationKeyXY: KEY_XY, createdAt: null })).ok)
    assert.deepEqual(
        await checkMinted({
            confirmationKeyXY: KEY_XY,
            createdAt: null,
            attestationValidity: { notBefore: new Date(now - 20 * DAY), notAfter: new Date(now - 10 * DAY) }
        }),
        { ok: false, reason: "CERT_EXPIRED", certIndex: 1 }
    )
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY, factory: true, createdAt: null })
    const factory = verifyChain({
        chain,
        roots: [await testRoot(true)],
        revokedSerials: NO_REVOCATIONS,
        now: Date.now(),
        confirmationKeyXY: KEY_XY
    })
    assert.ok(factory.ok, JSON.stringify(factory))
})

test("a root whose key OpenSSL cannot load is untrusted", async () => {
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY })
    const result = verifyChain({
        chain: [...chain.slice(0, -1), withUnloadableKey(chain[chain.length - 1])],
        roots: [await testRoot()],
        revokedSerials: NO_REVOCATIONS,
        now: Date.now(),
        confirmationKeyXY: KEY_XY
    })
    assert.deepEqual(result, { ok: false, reason: "UNTRUSTED_ROOT", certIndex: 4 })
})
