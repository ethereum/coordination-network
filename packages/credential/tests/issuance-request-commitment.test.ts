import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils"
import { Hex32, ISSUANCE_REQUEST_DOMAIN, issuanceRequestCommitment } from "@coordination-network/credential"

const ISSUER = `0x${"aa".repeat(32)}` as Hex32
const SCOPE = { programme: "test-programme", country: "ZZZ" }

function be32(value: bigint): Uint8Array {
    const bytes = new Uint8Array(32)
    for (let i = 31; i >= 0 && value > 0n; i -= 1) {
        bytes[i] = Number(value & 0xffn)
        value >>= 8n
    }
    return bytes
}

describe("issuanceRequestCommitment", () => {
    it("uses the issuance-request URN as its domain", () => {
        expect(ISSUANCE_REQUEST_DOMAIN).toBe("urn:cn:issuance-request:v1")
    })

    it("matches a hand-built preimage", () => {
        const preimage = concatBytes(
            utf8ToBytes("urn:cn:issuance-request:v1"),
            new Uint8Array(32).fill(0xaa),
            be32(BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes("test-programme")))}`) >> 8n),
            be32(BigInt(0x5a5a5a))
        )

        expect(bytesToHex(issuanceRequestCommitment(ISSUER, SCOPE))).toBe(bytesToHex(keccak_256(preimage)))
    })

    it("has a known answer", () => {
        expect(bytesToHex(issuanceRequestCommitment(ISSUER, SCOPE))).toBe(
            "bda971ea3537cbc95d7ced3f41abd889d59d655b70ddb47378fd62bc5fa4f2e4"
        )
    })

    it.each([
        ["issuer", () => issuanceRequestCommitment(`0x${"bb".repeat(32)}`, SCOPE)],
        ["programme", () => issuanceRequestCommitment(ISSUER, { ...SCOPE, programme: "other" })],
        ["country", () => issuanceRequestCommitment(ISSUER, { ...SCOPE, country: "XAA" })]
    ])("changes when the %s changes", (_name, build) => {
        expect(bytesToHex(build())).not.toBe(bytesToHex(issuanceRequestCommitment(ISSUER, SCOPE)))
    })

    it("rejects an issuer id longer than 32 bytes", () => {
        expect(() => issuanceRequestCommitment(`0x${"aa".repeat(33)}`, SCOPE)).toThrow(/issuerNetworkId/)
    })

    it("rejects an empty programme, a malformed country and a short issuer id", () => {
        expect(() => issuanceRequestCommitment(ISSUER, { ...SCOPE, programme: "" })).toThrow(/programme/)
        expect(() => issuanceRequestCommitment(ISSUER, { ...SCOPE, country: "zz" })).toThrow(/country/)
        expect(() => issuanceRequestCommitment("0xaa", SCOPE)).toThrow(/issuerNetworkId/)
    })

    it.each([
        ["a 63-digit id", `0x${"a".repeat(63)}`],
        ["a 64-character non-hex id", `0x${"g".repeat(64)}`]
    ])("rejects %s", (_name, issuerNetworkId) => {
        expect(() => issuanceRequestCommitment(issuerNetworkId as Hex32, SCOPE)).toThrow(/issuerNetworkId/)
    })
})
