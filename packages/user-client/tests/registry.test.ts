import { describe, it, expect } from "@jest/globals"
import { deriveKeys } from "@coordination-network/identity"
import { buildRegistrationRequest } from "../src/request"
import { InMemoryIdentityRegistry } from "../src/registry"
import { InMemoryMemberServer } from "../src/member-server"
import { SubmissionFailedError } from "../src/errors"
import { ChainDomain, Hex, RegistrationRequest } from "../src/types"

const DEVICE_SECRET_A: Hex = `0x${"33".repeat(32)}`
const DEVICE_SECRET_B: Hex = `0x${"44".repeat(32)}`
const DOMAIN: ChainDomain = {
    chainId: 31337,
    verifyingContract: `0x${"04".repeat(19)}e7`
}
const OTHER_DOMAIN: ChainDomain = {
    chainId: 1,
    verifyingContract: `0x${"05".repeat(19)}e7`
}

function flipOneHexChar(hex: Hex): Hex {
    const body = hex.slice(2)
    const index = 2
    const current = body[index]
    const flipped = current === "0" ? "1" : "0"
    return `0x${body.slice(0, index)}${flipped}${body.slice(index + 1)}` as Hex
}

describe("InMemoryIdentityRegistry", () => {
    it("returns null from getIdentity for a networkId that was never registered", async () => {
        const registry = new InMemoryIdentityRegistry()
        const keys = deriveKeys(DEVICE_SECRET_A)

        expect(await registry.getIdentity(keys.networkId)).toBeNull()
    })

    it("registerIdentity followed by getIdentity returns the exact metaStealthAddress", async () => {
        const registry = new InMemoryIdentityRegistry()
        const keys = deriveKeys(DEVICE_SECRET_A)
        const metaStealthAddress: Hex = `0x${"ab".repeat(66)}`

        registry.registerIdentity(keys.networkId, metaStealthAddress)

        expect(await registry.getIdentity(keys.networkId)).toBe(metaStealthAddress)
    })

    it("is write-once: registering the same networkId twice throws AlreadyRegistered", async () => {
        const registry = new InMemoryIdentityRegistry()
        const keys = deriveKeys(DEVICE_SECRET_A)
        const metaStealthAddress: Hex = `0x${"ab".repeat(66)}`

        registry.registerIdentity(keys.networkId, metaStealthAddress)

        expect(() => registry.registerIdentity(keys.networkId, metaStealthAddress)).toThrow(SubmissionFailedError)
        expect(() => registry.registerIdentity(keys.networkId, metaStealthAddress)).toThrow(/AlreadyRegistered/)
    })

    it("rejects a metaStealthAddress that is not 66 bytes as InvalidMetaStealthAddressLength", async () => {
        const registry = new InMemoryIdentityRegistry()
        const keys = deriveKeys(DEVICE_SECRET_A)
        const tooShort: Hex = `0x${"ab".repeat(65)}`

        expect(() => registry.registerIdentity(keys.networkId, tooShort)).toThrow(SubmissionFailedError)
        expect(() => registry.registerIdentity(keys.networkId, tooShort)).toThrow(/InvalidMetaStealthAddressLength/)
    })
})

describe("InMemoryMemberServer", () => {
    it("verifies consent, writes to the registry, and returns a 0x-hex txHash derived from the signature", async () => {
        const registry = new InMemoryIdentityRegistry()
        const memberServer = new InMemoryMemberServer(registry, DOMAIN)
        const keys = deriveKeys(DEVICE_SECRET_A)
        const request = buildRegistrationRequest(keys, DOMAIN)

        const receipt = await memberServer.submit(request)

        expect(receipt.txHash).toMatch(/^0x[0-9a-f]+$/)
        expect(await registry.getIdentity(request.networkId)).toBe(request.metaStealthAddress)
    })

    it("rejects a request with a tampered signature as InvalidRegistrationRequest", async () => {
        const registry = new InMemoryIdentityRegistry()
        const memberServer = new InMemoryMemberServer(registry, DOMAIN)
        const keys = deriveKeys(DEVICE_SECRET_A)
        const request = buildRegistrationRequest(keys, DOMAIN)
        const mutated: RegistrationRequest = { ...request, signature: flipOneHexChar(request.signature) }

        await expect(memberServer.submit(mutated)).rejects.toThrow(SubmissionFailedError)
        await expect(memberServer.submit(mutated)).rejects.toThrow(/InvalidRegistrationRequest/)
    })

    it("rejects a request signed for another registry deployment as InvalidRegistrationRequest", async () => {
        const registry = new InMemoryIdentityRegistry()
        const memberServer = new InMemoryMemberServer(registry, DOMAIN)
        const keys = deriveKeys(DEVICE_SECRET_A)
        const request = buildRegistrationRequest(keys, OTHER_DOMAIN)

        await expect(memberServer.submit(request)).rejects.toThrow(SubmissionFailedError)
        await expect(memberServer.submit(request)).rejects.toThrow(/InvalidRegistrationRequest/)
    })

    it("rejects a request whose envelope matches this deployment but was signed over a different domain's digest", async () => {
        const registry = new InMemoryIdentityRegistry()
        const memberServer = new InMemoryMemberServer(registry, DOMAIN)
        const keys = deriveKeys(DEVICE_SECRET_A)
        const request = buildRegistrationRequest(keys, OTHER_DOMAIN)
        const patched: RegistrationRequest = {
            ...request,
            chainId: DOMAIN.chainId,
            verifyingContract: DOMAIN.verifyingContract
        }

        await expect(memberServer.submit(patched)).rejects.toThrow(SubmissionFailedError)
        await expect(memberServer.submit(patched)).rejects.toThrow(/InvalidRegistrationRequest/)
    })

    it("rejects a duplicate submission as AlreadyRegistered", async () => {
        const registry = new InMemoryIdentityRegistry()
        const memberServer = new InMemoryMemberServer(registry, DOMAIN)
        const keys = deriveKeys(DEVICE_SECRET_A)
        const request = buildRegistrationRequest(keys, DOMAIN)

        await memberServer.submit(request)

        await expect(memberServer.submit(request)).rejects.toThrow(SubmissionFailedError)
        await expect(memberServer.submit(request)).rejects.toThrow(/AlreadyRegistered/)
    })

    it("accepts two different requests for two different networkIds independently", async () => {
        const registry = new InMemoryIdentityRegistry()
        const memberServer = new InMemoryMemberServer(registry, DOMAIN)
        const keysA = deriveKeys(DEVICE_SECRET_A)
        const keysB = deriveKeys(DEVICE_SECRET_B)
        const requestA = buildRegistrationRequest(keysA, DOMAIN)
        const requestB = buildRegistrationRequest(keysB, DOMAIN)

        const receiptA = await memberServer.submit(requestA)
        const receiptB = await memberServer.submit(requestB)

        expect(await registry.getIdentity(requestA.networkId)).toBe(requestA.metaStealthAddress)
        expect(await registry.getIdentity(requestB.networkId)).toBe(requestB.metaStealthAddress)
        expect(receiptA.txHash).not.toBe(receiptB.txHash)
    })
})
