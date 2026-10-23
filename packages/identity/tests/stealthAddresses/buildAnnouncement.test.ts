import { describe, it, expect } from "@jest/globals"

import { buildAnnouncement } from "../../src/stealthAddresses/buildAnnouncement"
import { checkStealthAddress } from "../../src/stealthAddresses/checkStealthAddress"
import { encodeMetaStealthAddress } from "../../src/stealthAddresses/encodeMetaStealthAddress"
import { computeSharedSecret } from "../../src/stealthAddresses/computeSharedSecret"
import { getViewTag } from "../../src/stealthAddresses/getViewTag"
import { hexToBytes } from "../../src/bytes"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

const { spending, viewing } = deriveKeys(seededSecret(0))
const metaStealthAddress = encodeMetaStealthAddress({
    spendingPublicKey: spending.publicKey,
    viewingPublicKey: viewing.publicKey
})

describe("buildAnnouncement", () => {
    it("builds an announcement which passes checkStealthAddress", () => {
        const announcement = buildAnnouncement({ metaStealthAddress })

        expect(
            checkStealthAddress({
                stealthAddress: announcement.stealthAddress,
                ephemeralPublicKey: announcement.ephemeralPublicKey,
                viewTag: hexToBytes(announcement.metadata)[0],
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(true)
    })

    it("derives a different stealth address per call (fresh account per load)", () => {
        const first = buildAnnouncement({ metaStealthAddress })
        const second = buildAnnouncement({ metaStealthAddress })

        expect(first.stealthAddress).not.toBe(second.stealthAddress)
    })

    it("sets schemeId to 1", () => {
        expect(buildAnnouncement({ metaStealthAddress }).schemeId).toBe(1)
    })

    it("returns a 33-byte compressed ephemeral public key", () => {
        const announcement = buildAnnouncement({ metaStealthAddress })

        expect(hexToBytes(announcement.ephemeralPublicKey)).toHaveLength(33)
        expect([0x02, 0x03]).toContain(hexToBytes(announcement.ephemeralPublicKey)[0])
    })

    it("returns the view tag as the single metadata byte", () => {
        const announcement = buildAnnouncement({ metaStealthAddress })
        const viewTag = getViewTag(
            computeSharedSecret({
                privateKey: viewing.privateKey,
                publicKey: announcement.ephemeralPublicKey
            })
        )

        expect(hexToBytes(announcement.metadata)).toEqual(Uint8Array.of(viewTag))
    })
})
