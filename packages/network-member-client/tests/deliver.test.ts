import { describe, expect, it, jest } from "@jest/globals"
import { checkStealthAddress } from "@coordination-network/identity"
import type { Hex } from "@coordination-network/identity"
import { InMemoryResolver } from "@coordination-network/credential"
import type { Hex32 } from "@coordination-network/credential"
import { NetworkMemberClientError } from "../src/errors"
import { deliverToStealth } from "../src/deliver"
import type { AnnouncementSubmitter, IdentityReader } from "../src/types"
import { createDeliverToStealthFixture } from "./fixtures"

const MEMBER_ID = `0x${"11".repeat(32)}` as Hex32
const RECIPIENT_ID = `0x${"22".repeat(32)}` as Hex32

function approvedResolver(): InMemoryResolver {
    const resolver = new InMemoryResolver()
    resolver.approveMember(MEMBER_ID)
    return resolver
}

function unusedSubmitter(): AnnouncementSubmitter {
    return { announce: jest.fn<AnnouncementSubmitter["announce"]>() }
}

class FixedIdentityReader implements IdentityReader {
    constructor(private readonly identities: Partial<Record<Hex32, Hex>>) {}

    async getIdentity(networkId: Hex32): Promise<Hex | null> {
        return this.identities[networkId] ?? null
    }
}

describe("deliverToStealth", () => {
    it("announces a stealth address scannable by the recipient's viewing key", async () => {
        const { spending, viewing, metaStealthAddress } = createDeliverToStealthFixture()
        const approval = approvedResolver()
        const identityReader = new FixedIdentityReader({ [RECIPIENT_ID]: metaStealthAddress })
        const submitter: AnnouncementSubmitter = { announce: jest.fn(async () => "0xtxhash" as Hex) }

        const result = await deliverToStealth(
            { memberNetworkId: MEMBER_ID, recipientNetworkId: RECIPIENT_ID },
            { approval, identityReader, submitter }
        )

        expect(result.stealthAddress).toBe(result.announcement.stealthAddress)
        expect(result.txHash).toBe("0xtxhash")
        expect(result.announcement.schemeId).toBe(1)
        expect(result.announcement.metadata).toMatch(/^0x[0-9a-f]{2}$/)

        expect(
            checkStealthAddress({
                stealthAddress: result.announcement.stealthAddress,
                ephemeralPublicKey: result.announcement.ephemeralPublicKey,
                viewTag: Number(result.announcement.metadata),
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(true)

        expect(submitter.announce).toHaveBeenCalledTimes(1)
        expect(submitter.announce).toHaveBeenCalledWith(result.announcement)
    })

    it("rejects an unapproved member before touching any other port", async () => {
        const approval = new InMemoryResolver() // MEMBER_ID never approved
        const identityReader: IdentityReader = { getIdentity: jest.fn<IdentityReader["getIdentity"]>() }
        const submitter = unusedSubmitter()

        const delivery = deliverToStealth(
            { memberNetworkId: MEMBER_ID, recipientNetworkId: RECIPIENT_ID },
            { approval, identityReader, submitter }
        )

        await expect(delivery).rejects.toThrow(NetworkMemberClientError)
        await expect(delivery).rejects.toMatchObject({ code: "MEMBER_NOT_APPROVED" })
        expect(identityReader.getIdentity).not.toHaveBeenCalled()
        expect(submitter.announce).not.toHaveBeenCalled()
    })

    it("rejects an unregistered recipient", async () => {
        const approval = approvedResolver()
        const identityReader = new FixedIdentityReader({})
        const submitter = unusedSubmitter()

        const delivery = deliverToStealth(
            { memberNetworkId: MEMBER_ID, recipientNetworkId: RECIPIENT_ID },
            { approval, identityReader, submitter }
        )

        await expect(delivery).rejects.toThrow(NetworkMemberClientError)
        await expect(delivery).rejects.toMatchObject({ code: "RECIPIENT_NOT_REGISTERED" })
        expect(submitter.announce).not.toHaveBeenCalled()
    })

    it("rejects a 66-byte meta-stealth address whose keys are not valid curve points", async () => {
        const approval = approvedResolver()
        const offCurve = `0x04${"ab".repeat(32)}02${"cd".repeat(32)}` as Hex
        const identityReader = new FixedIdentityReader({ [RECIPIENT_ID]: offCurve })
        const submitter = unusedSubmitter()

        const delivery = deliverToStealth(
            { memberNetworkId: MEMBER_ID, recipientNetworkId: RECIPIENT_ID },
            { approval, identityReader, submitter }
        )

        await expect(delivery).rejects.toThrow(NetworkMemberClientError)
        await expect(delivery).rejects.toMatchObject({ code: "INVALID_META_STEALTH_ADDRESS" })
        expect(submitter.announce).not.toHaveBeenCalled()
    })

    it("rejects a malformed meta-stealth address from the reader", async () => {
        const approval = approvedResolver()
        const identityReader = new FixedIdentityReader({ [RECIPIENT_ID]: "0xdeadbeef" as Hex })
        const submitter = unusedSubmitter()

        const delivery = deliverToStealth(
            { memberNetworkId: MEMBER_ID, recipientNetworkId: RECIPIENT_ID },
            { approval, identityReader, submitter }
        )

        await expect(delivery).rejects.toThrow(NetworkMemberClientError)
        await expect(delivery).rejects.toMatchObject({ code: "INVALID_META_STEALTH_ADDRESS" })
        expect(submitter.announce).not.toHaveBeenCalled()
    })
})
