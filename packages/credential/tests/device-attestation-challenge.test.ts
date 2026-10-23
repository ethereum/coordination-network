import { utf8ToBytes } from "@noble/hashes/utils"
import { DEVICE_ATTESTATION_CHALLENGE } from "@coordination-network/credential"

describe("DEVICE_ATTESTATION_CHALLENGE", () => {
    it("is the device-attestation URN", () => {
        expect(DEVICE_ATTESTATION_CHALLENGE).toBe("urn:cn:device-attestation:v1")
    })

    it("fits Android's 128-byte attestation challenge limit", () => {
        expect(utf8ToBytes(DEVICE_ATTESTATION_CHALLENGE).length).toBeLessThanOrEqual(128)
    })
})
