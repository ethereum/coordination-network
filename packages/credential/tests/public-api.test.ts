import * as credential from "../src"

describe("public API", () => {
    it("does not expose the legacy SD-JWT credential path", () => {
        for (const name of [
            "issueSdJwtCredential",
            "decodeSdJwtCredentialClaims",
            "presentSdJwtCredential",
            "verifySdJwtCredential",
            "verifySdJwtPresentation"
        ]) {
            expect(credential).not.toHaveProperty(name)
        }
    })
})
