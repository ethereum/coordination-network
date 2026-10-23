import { describe, expect, it } from "@jest/globals"
import { getKeystore, KEYSTORE_ERROR_CODES, keystoreErrorCode } from "../src/native"

describe("getKeystore", () => {
    it("returns null under jest, where expo-modules-core has no native module registered", () => {
        expect(getKeystore()).toBeNull()
    })
})

describe("keystoreErrorCode", () => {
    it("returns the code of a native rejection carrying one of the keystore codes", () => {
        for (const code of Object.values(KEYSTORE_ERROR_CODES)) {
            expect(keystoreErrorCode(Object.assign(new Error("rejected"), { code }))).toBe(code)
        }
    })

    it("pins the codes the Kotlin module raises", () => {
        expect(KEYSTORE_ERROR_CODES).toEqual({
            userCanceled: "ERR_USER_CANCELED",
            keyInvalidated: "ERR_KEY_INVALIDATED",
            noSecureLockScreen: "ERR_NO_SECURE_LOCK_SCREEN",
            unsupportedPlatform: "ERR_UNSUPPORTED_PLATFORM",
            authenticationFailed: "ERR_AUTHENTICATION_FAILED"
        })
    })

    it("returns null for a rejection whose code is not a keystore code", () => {
        expect(keystoreErrorCode(Object.assign(new Error("rejected"), { code: "ERR_KEY_NOT_FOUND" }))).toBeNull()
        expect(keystoreErrorCode(Object.assign(new Error("rejected"), { code: 5 }))).toBeNull()
    })

    it("returns null for a plain error", () => {
        expect(keystoreErrorCode(new Error("ERR_USER_CANCELED"))).toBeNull()
    })

    it("returns null for a value that is not an error", () => {
        expect(keystoreErrorCode("ERR_USER_CANCELED")).toBeNull()
        expect(keystoreErrorCode(undefined)).toBeNull()
        expect(keystoreErrorCode(null)).toBeNull()
    })
})
