// config.ts imports AsyncStorage at module scope even though these tests only exercise the pure
// parser. jest.mock's factory may only reference variables prefixed `mock` — hence the name here.
import mockAsyncStorage from "@react-native-async-storage/async-storage/jest/async-storage-mock"

jest.mock("@react-native-async-storage/async-storage", () => mockAsyncStorage)

import {
    parseStackDescriptor,
    readStackConfig,
    resolveStackDescriptor,
    writeStackConfig,
    type StackDescriptor
} from "../config"

const valid: StackDescriptor = {
    rpcUrl: "http://192.168.1.10:8545",
    chainId: 31337,
    identityRegistry: "0x1111111111111111111111111111111111111111",
    announcer: "0x2222222222222222222222222222222222222222",
    revocation: {
        address: "0x3333333333333333333333333333333333333333",
        registry: "0x3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a",
        registryId: "1"
    },
    semaphore: "0x4444444444444444444444444444444444444444",
    networkMemberRegistry: "0x5555555555555555555555555555555555555555",
    networkMemberGroup: "0x6666666666666666666666666666666666666666",
    networkMemberGovernance: "0x7777777777777777777777777777777777777777",
    approvedIssuerSet: "0x8888888888888888888888888888888888888888",
    governanceSafe: "0x9999999999999999999999999999999999999999",
    entryPoint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    paymaster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    accountImplementation: "0xcccccccccccccccccccccccccccccccccccccc",
    bundlerUrl: "http://192.168.1.10:4337",
    dashboardUrl: "http://192.168.1.10:8080",
    members: [
        {
            name: "member-a",
            networkId: "0x4444",
            serverUrl: "http://192.168.1.10:3001",
            authAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
            governanceSigner: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            role: "founder",
            brand: { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" },
            scheme: "member-a"
        }
    ]
}

describe("parseStackDescriptor", () => {
    it("accepts a well-formed stack.json", () => {
        expect(parseStackDescriptor(JSON.stringify(valid))).toEqual(valid)
    })

    it("rejects text that isn't JSON", () => {
        expect(() => parseStackDescriptor("not json")).toThrow(/valid JSON/)
    })

    it("rejects a JSON value that isn't an object", () => {
        expect(() => parseStackDescriptor("42")).toThrow(/JSON object/)
    })

    it.each([
        "rpcUrl",
        "chainId",
        "identityRegistry",
        "announcer",
        "semaphore",
        "networkMemberRegistry",
        "networkMemberGroup",
        "networkMemberGovernance",
        "approvedIssuerSet",
        "governanceSafe",
        "entryPoint",
        "paymaster",
        "accountImplementation",
        "bundlerUrl",
        "dashboardUrl"
    ] as const)("rejects a missing %s, naming that field", (field) => {
        const broken: Record<string, unknown> = { ...valid }
        delete broken[field]
        expect(() => parseStackDescriptor(JSON.stringify(broken))).toThrow(new RegExp(field))
    })

    it("rejects a missing revocation.address", () => {
        const broken = { ...valid, revocation: {} }
        expect(() => parseStackDescriptor(JSON.stringify(broken))).toThrow(/revocation/)
    })

    // A stack.json written before the network moved to one shared registry carried the service
    // address alone and a registry id on every member. Rejecting it sends the person back to
    // Setup rather than letting the wallet present against a registry it can't name.
    it("rejects a descriptor from before the network had one shared registry", () => {
        const broken = { ...valid, revocation: { address: valid.revocation.address } }
        expect(() => parseStackDescriptor(JSON.stringify(broken))).toThrow(/revocation\.registry/)
    })

    it("rejects a malformed member, naming its index and the first bad field", () => {
        const broken = { ...valid, members: [{ name: "no-network-id" }] }
        expect(() => parseStackDescriptor(JSON.stringify(broken))).toThrow(/members\[0\]\.\w+/)
    })

    it("rejects a member missing its role, naming that field", () => {
        const broken = { ...valid, members: [{ ...valid.members[0], role: "owner" }] }
        expect(() => parseStackDescriptor(JSON.stringify(broken))).toThrow(/members\[0\]\.role/)
    })

    it("names the one bad field in an otherwise well-formed member", () => {
        const broken = { ...valid, members: [{ ...valid.members[0], networkId: "not-hex" }] }
        expect(() => parseStackDescriptor(JSON.stringify(broken))).toThrow(/members\[0\]\.networkId/)
    })

    it("rejects a member missing its brand", () => {
        const broken: Record<string, unknown> = { ...valid.members[0] }
        delete broken.brand
        expect(() => parseStackDescriptor(JSON.stringify({ ...valid, members: [broken] }))).toThrow(
            /members\[0\]\.brand/
        )
    })

    it("rejects a brand hex field that isn't a CSS hex colour, naming that field", () => {
        const broken = { ...valid.members[0], brand: { ...valid.members[0].brand, accentSoft: "0x123456" } }
        expect(() => parseStackDescriptor(JSON.stringify({ ...valid, members: [broken] }))).toThrow(
            /members\[0\]\.brand\.accentSoft/
        )
    })

    it("rejects a non-string scheme, naming that field", () => {
        const broken = { ...valid.members[0], scheme: 1 }
        expect(() => parseStackDescriptor(JSON.stringify({ ...valid, members: [broken] }))).toThrow(
            /members\[0\]\.scheme/
        )
    })

    it("accepts a member with no scheme at all", () => {
        const { scheme, ...rest } = valid.members[0]
        expect(scheme).toBeDefined()
        const stack = { ...valid, members: [rest] }
        expect(parseStackDescriptor(JSON.stringify(stack))).toEqual(stack)
    })

    it("keeps only the fields a member has, so an org's token an older stack served is never stored", () => {
        const stale = { ...valid, members: valid.members.map((member) => ({ ...member, memberServerToken: "t" })) }
        const parsed = parseStackDescriptor(JSON.stringify(stale))
        expect(parsed).toEqual(valid)
        expect(JSON.stringify(parsed)).not.toContain("memberServerToken")
    })
})

describe("readStackConfig", () => {
    afterEach(async () => {
        await mockAsyncStorage.clear()
    })

    it("returns null when nothing is stored", async () => {
        await expect(readStackConfig()).resolves.toBeNull()
    })

    it("returns the parsed descriptor for a well-formed stored value", async () => {
        await writeStackConfig(valid)
        await expect(readStackConfig()).resolves.toEqual(valid)
    })

    it("returns null, not a throw, for a descriptor an older build persisted with a field missing", async () => {
        const stale: Record<string, unknown> = { ...valid }
        delete stale.approvedIssuerSet
        await mockAsyncStorage.setItem("user-app.stack-config", JSON.stringify(stale))

        await expect(readStackConfig()).resolves.toBeNull()
    })
})

describe("resolveStackDescriptor", () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
    })

    it("parses pasted JSON directly, without fetching anything", async () => {
        global.fetch = jest.fn()
        await expect(resolveStackDescriptor(JSON.stringify(valid))).resolves.toEqual(valid)
        expect(global.fetch).not.toHaveBeenCalled()
    })

    it("fetches an http(s) URL and parses its body as stack.json", async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(valid)
        })) as never

        await expect(resolveStackDescriptor("https://dashboard.example/stack.json")).resolves.toEqual(valid)
        expect(global.fetch).toHaveBeenCalledWith("https://dashboard.example/stack.json")
    })

    it("rejects a failed fetch with the response status", async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => "" })) as never

        await expect(resolveStackDescriptor("https://dashboard.example/stack.json")).rejects.toThrow(/503/)
    })
})
