import { describe, expect, it, jest } from "@jest/globals"
import { CREDENTIAL_PREFIX, REVOCATION_SECRET_PREFIX } from "@coordination-network/wallet"
import type { CredentialIssueParams } from "@coordination-network/user-app-link"
import { DEVICE_SECRET_KEY } from "../src/device-secret"
import { readIssuerEntry } from "../src/issuer-index"
import { createUserAppService } from "../src/service"
import type { ConsentScope, UserAppService } from "../src/types"
import { createServiceHarness, type ServiceHarness } from "./support/harness"
import { createMemberStack, type MemberStack } from "./support/member-stack"
import { createTestDeviceKey, type TestDeviceKey } from "./support/test-device-key"

const CALLER = { name: "test-member", scheme: "testmember" }
const APPROVAL_SCOPE = { programme: "demo-programme", country: "ZZZ" }
const OTHER_SCOPE = { programme: "alt-programme", country: "ZZZ" }
const HOST_KEY = "host-app:stack-config"

const issue = (service: UserAppService, memberStack: MemberStack, approvalScope: ConsentScope = APPROVAL_SCOPE) => {
    const params: CredentialIssueParams = {
        issuerNetworkId: memberStack.issuerNetworkId,
        approvalScope,
        challengeUrl: memberStack.challengeUrl,
        credentialsUrl: memberStack.credentialsUrl,
        issuersUrl: memberStack.issuersUrl,
        revocationsUrl: memberStack.revocationsUrl
    }
    return service.handlers["credential.issue"]!(params, { caller: CALLER })
}

async function holdingOne(): Promise<{ harness: ServiceHarness; memberStack: MemberStack }> {
    const harness = createServiceHarness()
    await harness.service.createIdentity()
    const memberStack = await createMemberStack(harness.http, { now: () => harness.now.value })
    harness.roots.read = async () => memberStack.chainRoots()
    expect((await issue(harness.service, memberStack)).status).toBe("stored")
    return { harness, memberStack }
}

/** The app's rebuild after the keys were replaced: the same store, a fresh service, new keys. */
function withReplacedKeys(harness: ServiceHarness): { service: UserAppService; deviceKey: TestDeviceKey } {
    const deviceKey = createTestDeviceKey()
    return { service: createUserAppService({ ...harness.ports, deviceKey }), deviceKey }
}

const ecdhCalls = (deviceKey: TestDeviceKey) => deviceKey.calls.filter((call) => call === "ecdh").length

describe("listCredentials and the device keys", () => {
    it("makes no key call at all", async () => {
        const { harness } = await holdingOne()
        harness.deviceKey.calls.length = 0

        expect(await harness.service.listCredentials()).toHaveLength(1)
        expect(harness.deviceKey.calls).toEqual([])
    })
})

describe("removeUnboundCredentials", () => {
    it("keeps a credential bound to the current keys, reading only the public key", async () => {
        const { harness } = await holdingOne()
        const before = (await harness.store.list()).sort()
        harness.deviceKey.calls.length = 0
        harness.deviceKey.prompts.length = 0

        expect(await harness.service.removeUnboundCredentials()).toBe(0)

        expect(harness.deviceKey.calls).toEqual(["getPublicKeyJwk"])
        expect(harness.deviceKey.prompts).toEqual([])
        expect((await harness.store.list()).sort()).toEqual(before)
    })

    it("removes a credential bound to replaced keys, with its revocation secret and index entry, and keeps the rest", async () => {
        const { harness } = await holdingOne()
        await harness.store.set(HOST_KEY, "kept")
        const before = await harness.store.list()
        expect(before.some((key) => key.startsWith(CREDENTIAL_PREFIX))).toBe(true)
        expect(before.some((key) => key.startsWith(REVOCATION_SECRET_PREFIX))).toBe(true)
        expect(before.some((key) => key.startsWith("user-app-core:issuer-index:"))).toBe(true)
        const rebuilt = withReplacedKeys(harness)

        expect(await rebuilt.service.removeUnboundCredentials()).toBe(1)

        expect((await harness.store.list()).sort()).toEqual([DEVICE_SECRET_KEY, HOST_KEY].sort())
        expect(await rebuilt.service.isOnboarded()).toBe(true)
        expect(await rebuilt.service.listCredentials()).toEqual([])
        expect(rebuilt.deviceKey.calls).toEqual(["getPublicKeyJwk"])
        expect(rebuilt.deviceKey.prompts).toEqual([])
    })

    it("removes only the unbound credential when one of each is held", async () => {
        const { harness, memberStack } = await holdingOne()
        const rebuilt = withReplacedKeys(harness)
        const kept = await issue(rebuilt.service, memberStack, OTHER_SCOPE)
        const keptId = kept.status === "stored" ? kept.credentialId : ""
        expect(keptId).not.toBe("")

        expect(await rebuilt.service.removeUnboundCredentials()).toBe(1)

        expect((await rebuilt.service.listCredentials()).map(({ id }) => id)).toEqual([keptId])
        expect(await harness.store.get(`${REVOCATION_SECRET_PREFIX}${keptId}`)).not.toBeNull()
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, OTHER_SCOPE)).toMatchObject({
            credentialId: keptId
        })
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toBeNull()
    })

    it("skips a record it cannot read or parse, leaving it in place, and still removes the unbound one", async () => {
        const { harness, memberStack } = await holdingOne()
        const rebuilt = withReplacedKeys(harness)
        const kept = await issue(rebuilt.service, memberStack, OTHER_SCOPE)
        const keptId = kept.status === "stored" ? kept.credentialId : ""
        await harness.store.set(`${CREDENTIAL_PREFIX}not-json`, "{not json")
        await harness.store.set(
            `${CREDENTIAL_PREFIX}bad-credential`,
            JSON.stringify({ credential: "garbage", checkedAt: null })
        )

        expect(await rebuilt.service.removeUnboundCredentials()).toBe(1)

        const keys = await harness.store.list()
        expect(keys).toContain(`${CREDENTIAL_PREFIX}not-json`)
        expect(keys).toContain(`${CREDENTIAL_PREFIX}bad-credential`)
        expect(keys).toContain(`${CREDENTIAL_PREFIX}${keptId}`)
        expect(keys.filter((key) => key.startsWith(CREDENTIAL_PREFIX))).toHaveLength(3)
    })

    it("leaves an unparsable index entry in place and still removes the unbound credential's own entry", async () => {
        const { harness, memberStack } = await holdingOne()
        const corruptKey = "user-app-core:issuer-index:0x00:corrupt:ZZZ"
        await harness.store.set(corruptKey, "{not json")
        const rebuilt = withReplacedKeys(harness)

        expect(await rebuilt.service.removeUnboundCredentials()).toBe(1)

        expect(await harness.store.get(corruptKey)).toBe("{not json")
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toBeNull()
    })

    it("lets credential.issue issue again instead of answering alreadyHeld for a removed credential", async () => {
        const { harness, memberStack } = await holdingOne()
        const rebuilt = withReplacedKeys(harness)
        expect((await issue(rebuilt.service, memberStack)).status).toBe("alreadyHeld")

        await rebuilt.service.removeUnboundCredentials()

        expect((await issue(rebuilt.service, memberStack)).status).toBe("stored")
    })

    it("forgets the cached seed only when it removed something", async () => {
        const { harness, memberStack } = await holdingOne()
        const before = ecdhCalls(harness.deviceKey)

        expect(await harness.service.removeUnboundCredentials()).toBe(0)
        expect((await issue(harness.service, memberStack, OTHER_SCOPE)).status).toBe("stored")
        expect(ecdhCalls(harness.deviceKey)).toBe(before)

        const replacedJwk = await createTestDeviceKey().getPublicKeyJwk()
        jest.spyOn(harness.deviceKey, "getPublicKeyJwk").mockResolvedValueOnce(replacedJwk)
        expect(await harness.service.removeUnboundCredentials()).toBe(2)
        expect((await issue(harness.service, memberStack)).status).toBe("stored")
        expect(ecdhCalls(harness.deviceKey)).toBe(before + 1)
    })

    it("erase also forgets the cached seed", async () => {
        const { harness } = await holdingOne()
        await harness.service.erase()
        harness.deviceKey.calls.length = 0

        await harness.service.createIdentity()
        const memberStack = await createMemberStack(harness.http, { now: () => harness.now.value })
        harness.roots.read = async () => memberStack.chainRoots()
        await issue(harness.service, memberStack)

        expect(ecdhCalls(harness.deviceKey)).toBe(1)
    })
})

describe("removeUnboundCredentials behind an operation in flight", () => {
    it("waits for a presentation paused at its review, then removes what that presentation used", async () => {
        const { harness, memberStack } = await holdingOne()
        const order: string[] = []
        let release!: (approved: boolean) => void
        const paused = new Promise<boolean>((resolve) => (release = resolve))
        harness.ports.review = async () => {
            order.push("review-started")
            return paused
        }
        harness.proofGenerator.generateProof = async () => {
            order.push("proof")
            return { proof: Uint8Array.from([1]), publicInputs: ["1"] }
        }

        const presenting = harness.service.handlers["presentation.create"]!(
            {
                requestId: "req-1",
                challenge: `0x${"0d".repeat(31)}`,
                audience: "urn:cn:network:verifier",
                currentTime: Math.floor(Date.now() / 1000),
                programme: "demo-programme",
                country: "ZZZ",
                issuersUrl: memberStack.issuersUrl,
                revocationsUrl: memberStack.revocationsUrl,
                responseUrl: memberStack.verifyUrl
            },
            { caller: CALLER }
        )
        presenting.then(
            () => order.push("presented"),
            () => order.push("presented")
        )
        while (!order.includes("review-started")) await new Promise((resolve) => setTimeout(resolve, 0))

        // The presentation signs through `signerFor`, so only the reconciliation reads this.
        jest.spyOn(harness.deviceKey, "getPublicKeyJwk").mockResolvedValueOnce(
            await createTestDeviceKey().getPublicKeyJwk()
        )
        const removing = harness.service.removeUnboundCredentials().then(() => order.push("removed"))
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
        expect(order).toEqual(["review-started"])
        expect(await harness.service.listCredentials()).toHaveLength(1)

        release(true)
        await Promise.all([presenting, removing])

        expect(order).toEqual(["review-started", "proof", "presented", "removed"])
        expect(await harness.service.listCredentials()).toEqual([])
        expect((await harness.store.list()).filter((key) => key.startsWith(CREDENTIAL_PREFIX))).toEqual([])
    })
})
