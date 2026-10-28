import { InMemoryResolver } from "../src/resolver"
import { LocalP256Signer } from "../src/crypto"
import { ISSUER_ID, OTHER_ISSUER_ID } from "./fixtures"

describe("InMemoryResolver", () => {
    it("removes only the requested approval without removing its published key", async () => {
        const resolver = new InMemoryResolver()
        const key = await LocalP256Signer.generate().getPublicKeyJwk()
        resolver.approveMember(ISSUER_ID)
        resolver.approveMember(OTHER_ISSUER_ID)
        resolver.setCredentialPublicKey(ISSUER_ID, key)
        resolver.removeMember(ISSUER_ID)

        await expect(resolver.isApprovedNetworkMember(ISSUER_ID)).resolves.toBe(false)
        await expect(resolver.isApprovedNetworkMember(OTHER_ISSUER_ID)).resolves.toBe(true)
        await expect(resolver.getCredentialPublicKey(ISSUER_ID)).resolves.toEqual(key)
        await expect(resolver.getCredentialPublicKey(OTHER_ISSUER_ID)).resolves.toBeNull()
    })

    it("replaces a member's key and keeps repeated revocations idempotent", async () => {
        const resolver = new InMemoryResolver()
        const first = await LocalP256Signer.generate().getPublicKeyJwk()
        const replacement = await LocalP256Signer.generate().getPublicKeyJwk()
        resolver.setCredentialPublicKey(ISSUER_ID, first)
        resolver.setCredentialPublicKey(ISSUER_ID, replacement)
        await resolver.revoke(123n)
        await resolver.revoke(123n)

        await expect(resolver.getCredentialPublicKey(ISSUER_ID)).resolves.toEqual(replacement)
        await expect(resolver.isRevoked(123n)).resolves.toBe(true)
        await expect(resolver.isRevoked(124n)).resolves.toBe(false)
    })
})
