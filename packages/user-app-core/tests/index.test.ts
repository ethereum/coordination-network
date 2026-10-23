import { describe, expect, it } from "@jest/globals"
import * as UserAppCore from "../src/index"

describe("public entry point", () => {
    it("exports the service factory and the other public helpers", () => {
        expect(typeof UserAppCore.createUserAppService).toBe("function")
        expect(typeof UserAppCore.mapWalletError).toBe("function")
        expect(new UserAppCore.DeviceKeyError("USER_CANCELED").code).toBe("USER_CANCELED")
        expect(typeof UserAppCore.matchingCredentials).toBe("function")
        expect(typeof UserAppCore.latestExpiring).toBe("function")
        expect(typeof UserAppCore.buildConsentSummary).toBe("function")
        expect(typeof UserAppCore.readIssuerEntry).toBe("function")
        expect(typeof UserAppCore.listIssuerEntries).toBe("function")
    })
})
