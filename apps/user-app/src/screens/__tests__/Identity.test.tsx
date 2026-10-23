jest.mock("../../chain-reads", () => ({ readIsRegistered: jest.fn() }))

import type { Hex } from "@coordination-network/identity"
import type { PublicIdentity, UserAppService } from "@coordination-network/user-app-core"
import { allText, findPressables, press, renderScreen } from "@coordination-network/app-ui/testing"
import IdentityScreen from "../Identity"
import { readIsRegistered } from "../../chain-reads"
import { testStack } from "../../test-stack"

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

const identity: PublicIdentity = {
    networkId: `0x${"11".repeat(32)}` as Hex,
    metaStealthAddress: `0x${"22".repeat(66)}` as Hex,
    accountPublicKey: `0x${"33".repeat(65)}` as Hex,
    securityLevel: "SOFTWARE"
}

const stack = testStack()

function fakeService(onboarded: boolean, overrides: Partial<UserAppService> = {}): UserAppService {
    return {
        handlers: {},
        consent: async () => true,
        isOnboarded: async () => onboarded,
        createIdentity: async () => identity,
        readIdentity: async () => identity,
        listCredentials: async () => [],
        readStealthScanKeys: async () => {
            throw new Error("not used in this screen")
        },
        erase: async () => undefined,
        removeUnboundCredentials: async () => 0,
        ...overrides
    }
}

describe("IdentityScreen", () => {
    it("invites the person to create an identity before onboarding", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(false)} stack={null} />)

        const text = allText(tree)
        expect(text).toContain("Create your identity")
        expect(text).toContain("It stays on this phone.")
        expect(text).toContain("Create identity")
    })

    it("confirms the setup once the create button is pressed, above the identity's own fields", async () => {
        const service = fakeService(false)
        const tree = await renderScreen(<IdentityScreen service={service} stack={null} />)

        await press(tree)

        const text = allText(tree)
        expect(text).toContain("Setup complete")
        expect(text).toContain("You can now register for network members' services")
        // `KeyValue` truncates a value this long by default, so only its head survives.
        expect(text.some((line) => line.startsWith(identity.networkId.slice(0, 6)))).toBe(true)
    })

    it("does not congratulate a person who already had an identity", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={null} />)

        expect(allText(tree)).not.toContain("Setup complete")
    })

    it("shows an error instead of spinning forever when readIdentity rejects", async () => {
        const service = fakeService(true, {
            readIdentity: async () => {
                throw new Error("hardware ECDH failed")
            }
        })
        const tree = await renderScreen(<IdentityScreen service={service} stack={null} />)

        expect(allText(tree)).toContain("hardware ECDH failed")
    })

    it("shows the held identity's fields once onboarded", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={null} />)

        const text = allText(tree)
        expect(text).toContain("Network ID")
        expect(text).toContain("Meta-stealth address")
        expect(text).toContain("Account public key")
        expect(text).toContain("Security level")
        expect(text).toContain("Registration")
        expect(text.some((line) => line.startsWith(identity.networkId.slice(0, 6)))).toBe(true)
        expect(text).toContain(identity.securityLevel)
    })

    it("keeps each field's one sentence behind its info icon until it is asked for", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={null} />)

        expect(allText(tree)).not.toContain("Your public name on the network.")

        // Each row renders its hint toggle before its own value, so the first Pressable is Network ID's.
        await press(tree, 0)

        expect(allText(tree)).toContain("Your public name on the network.")
    })

    it("says nothing the fields do not, with both standing notes gone", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={null} />)

        const text = allText(tree).join(" ")
        expect(text).not.toContain("sponsored by the network's paymaster")
        expect(text).not.toContain("reported by the platform as-is")
        expect(text).not.toContain("generated here, never sent anywhere")
    })

    it("asks to configure the stack before checking registration", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={null} />)

        expect(allText(tree)).toContain("Configure the stack")
        expect(readIsRegistered).not.toHaveBeenCalled()
    })

    it("reports registered once the registry has an entry", async () => {
        jest.mocked(readIsRegistered).mockResolvedValueOnce(true)
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={stack} />)
        await flush()

        expect(allText(tree)).toContain("Registered")
    })

    it("reports not registered when the registry entry is empty", async () => {
        jest.mocked(readIsRegistered).mockResolvedValueOnce(false)
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={stack} />)
        await flush()

        expect(allText(tree)).toContain("Not registered")
    })

    it("shows chain unreachable instead of checking forever when the RPC read fails", async () => {
        jest.mocked(readIsRegistered).mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
        const tree = await renderScreen(<IdentityScreen service={fakeService(true)} stack={stack} />)
        await flush()

        expect(allText(tree)).toContain("Chain unreachable")
    })

    it("offers one action on the empty state and nothing else to press", async () => {
        const tree = await renderScreen(<IdentityScreen service={fakeService(false)} stack={null} />)

        expect(findPressables(tree)).toHaveLength(1)
    })
})
