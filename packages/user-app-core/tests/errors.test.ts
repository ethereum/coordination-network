import { describe, expect, it } from "@jest/globals"
import { WalletError, type WalletErrorCode } from "@coordination-network/wallet"
import type { LinkErrorCode } from "@coordination-network/user-app-link"
import { DeviceKeyError, mapDeviceKeyError, mapWalletError } from "../src/errors"

describe("mapDeviceKeyError", () => {
    it("reads a cancel as the person's refusal and anything else as INTERNAL", () => {
        expect(mapDeviceKeyError(new DeviceKeyError("USER_CANCELED")).code).toBe("CONSENT_DENIED")
        expect(mapDeviceKeyError(new DeviceKeyError("KEY_INVALIDATED")).code).toBe("INTERNAL")
        expect(mapDeviceKeyError(new DeviceKeyError("AUTHENTICATION_FAILED")).code).toBe("INTERNAL")
        expect(mapDeviceKeyError(new Error("boom")).code).toBe("INTERNAL")
        expect(mapDeviceKeyError("boom").message).toBe("boom")
    })
})

describe("mapWalletError", () => {
    const table: [WalletErrorCode, LinkErrorCode][] = [
        ["NOT_FOUND", "NO_CREDENTIAL"],
        ["ALREADY_STORED", "INVALID_REQUEST"],
        ["CREDENTIAL_INVALID", "INVALID_REQUEST"],
        ["CONSENT_DENIED", "CONSENT_DENIED"],
        ["REVOKED", "CREDENTIAL_REVOKED"],
        ["CHAIN_STATE_UNAVAILABLE", "VERIFIER_UNREACHABLE"],
        ["CHAIN_STATE_INVALID", "VERIFIER_UNREACHABLE"],
        ["NOT_YET_VALID", "NO_CREDENTIAL"],
        ["EXPIRED", "NO_CREDENTIAL"],
        ["ISSUER_NOT_APPROVED", "NO_CREDENTIAL"],
        ["PRESENTATION_FAILED", "PROOF_FAILED"]
    ]

    it.each(table)("maps WalletError %s to LinkError %s", (walletCode, linkCode) => {
        const mapped = mapWalletError(new WalletError(walletCode, "some detail"))
        expect(mapped.code).toBe(linkCode)
        expect(mapped.message).toBe("some detail")
    })

    it("covers every WalletErrorCode", () => {
        expect(table.map(([walletCode]) => walletCode).sort()).toEqual(
            [
                "NOT_FOUND",
                "ALREADY_STORED",
                "CREDENTIAL_INVALID",
                "CONSENT_DENIED",
                "REVOKED",
                "CHAIN_STATE_UNAVAILABLE",
                "CHAIN_STATE_INVALID",
                "NOT_YET_VALID",
                "EXPIRED",
                "ISSUER_NOT_APPROVED",
                "PRESENTATION_FAILED"
            ].sort()
        )
    })

    // Issuance reads the issuer's own lists; reporting that as a verifier problem would name a
    // party the flow never involves.
    it("re-points only the chain-state codes when the caller names whose lists it was reading", () => {
        expect(mapWalletError(new WalletError("CHAIN_STATE_UNAVAILABLE", "down"), "ISSUER_UNREACHABLE").code).toBe(
            "ISSUER_UNREACHABLE"
        )
        expect(mapWalletError(new WalletError("CHAIN_STATE_INVALID", "mismatch"), "ISSUER_UNREACHABLE").code).toBe(
            "ISSUER_UNREACHABLE"
        )
        expect(mapWalletError(new WalletError("REVOKED", "revoked"), "ISSUER_UNREACHABLE").code).toBe(
            "CREDENTIAL_REVOKED"
        )
    })

    it("defers to the device key's own error when the wallet wrapped one", () => {
        const wrapped = (code: DeviceKeyError["code"]) =>
            new WalletError("PRESENTATION_FAILED", "wrapped", new DeviceKeyError(code))
        expect(mapWalletError(wrapped("USER_CANCELED")).code).toBe("CONSENT_DENIED")
        expect(mapWalletError(wrapped("KEY_INVALIDATED")).code).toBe("INTERNAL")
        expect(mapWalletError(wrapped("AUTHENTICATION_FAILED")).code).toBe("INTERNAL")
    })

    it("maps a non-WalletError to INTERNAL rather than a LinkError with no code", () => {
        // Wallet.syncRevocations parses each stored credential and writes each record back, so a
        // corrupt record or a failing device store reaches this mapper as an ordinary Error.
        const mapped = mapWalletError(new Error("SecureStore unavailable"))
        expect(mapped.code).toBe("INTERNAL")
        expect(mapped.message).toBe("SecureStore unavailable")
    })

    it("maps a thrown non-Error to INTERNAL", () => {
        expect(mapWalletError("boom").code).toBe("INTERNAL")
        expect(mapWalletError("boom").message).toBe("boom")
    })
})
