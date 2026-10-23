import type { Wallet } from "@coordination-network/wallet"
import { presentationConsentDecision } from "../src/consent-policy"

describe("presentation consent policy", () => {
    const wallet = (status: "valid" | "revoked" | "expired") =>
        ({
            syncRevocations: jest.fn().mockResolvedValue(undefined),
            listCredentials: jest.fn().mockResolvedValue([{ status }])
        }) as unknown as Pick<Wallet, "syncRevocations" | "listCredentials">

    it("asks for consent when an approval can be presented", async () => {
        await expect(presentationConsentDecision(wallet("valid"))).resolves.toBe("prompt")
    })

    it.each(["revoked", "expired"] as const)("denies a known %s approval", async (status) => {
        await expect(presentationConsentDecision(wallet(status))).resolves.toBe("deny")
    })

    it("asks for consent when current status cannot be loaded", async () => {
        const unavailable = {
            syncRevocations: jest.fn().mockRejectedValue(new Error("offline")),
            listCredentials: jest.fn()
        } as unknown as Pick<Wallet, "syncRevocations" | "listCredentials">
        await expect(presentationConsentDecision(unavailable)).resolves.toBe("prompt")
    })
})
