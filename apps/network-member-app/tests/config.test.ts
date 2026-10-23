import { afterEach, describe, expect, it, jest } from "@jest/globals"
import AsyncStorage from "@react-native-async-storage/async-storage"
import {
    STORAGE_KEY,
    StackConfigError,
    buildMemberConfig,
    clearStoredPairing,
    loadStoredPairing,
    parseStackDescriptor,
    resolvePairing,
    storePairing
} from "../src/config"
import { PAIRING_URL_A, fakePairing, fakeStack, withStackJson } from "./support"

describe("config", () => {
    describe("memberId", () => {
        const originalMemberId = process.env.EXPO_PUBLIC_MEMBER_ID

        afterEach(() => {
            process.env.EXPO_PUBLIC_MEMBER_ID = originalMemberId
        })

        it("rejects an EXPO_PUBLIC_MEMBER_ID that isn't one of MEMBER_IDS", () => {
            process.env.EXPO_PUBLIC_MEMBER_ID = "member-z"

            jest.isolateModules(() => {
                // memberId is computed at module load, so only a fresh require re-reads the env var.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                expect(() => require("../src/config")).toThrow(/member-z/)
            })
        })

        it("refuses to start with no EXPO_PUBLIC_MEMBER_ID rather than picking a member", () => {
            delete process.env.EXPO_PUBLIC_MEMBER_ID

            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                expect(() => require("../src/config")).toThrow(/got nothing/)
            })
        })
    })

    describe("buildMemberConfig", () => {
        it("resolves member-a to the stack's first member, with the token its pairing link carried", () => {
            const config = buildMemberConfig(fakePairing(), "member-a", "Member A")

            expect(config).toEqual({
                networkId: fakeStack().members[0].networkId,
                displayName: "Member A",
                serverUrl: fakeStack().members[0].serverUrl,
                registry: { chainId: fakeStack().chainId, verifyingContract: fakeStack().identityRegistry },
                memberServerToken: "member-token-a"
            })
        })

        it("resolves member-b to the stack's second member", () => {
            const config = buildMemberConfig(fakePairing(), "member-b", "Member B")

            expect(config.networkId).toBe(fakeStack().members[1].networkId)
            expect(config.serverUrl).toBe(fakeStack().members[1].serverUrl)
        })

        it("throws when the stack has no member at that index", () => {
            const stack = fakeStack()
            stack.members = [stack.members[0]]

            expect(() => buildMemberConfig({ ...fakePairing(), stack }, "member-b", "Member B")).toThrow(
                StackConfigError
            )
        })
    })

    describe("parseStackDescriptor", () => {
        it("round-trips a real stack.json", () => {
            const stack = fakeStack()
            expect(parseStackDescriptor(JSON.stringify(stack))).toEqual(stack)
        })

        it("rejects text that isn't JSON", () => {
            expect(() => parseStackDescriptor("not json")).toThrow(StackConfigError)
        })

        it("rejects JSON that doesn't match the stack.json shape", () => {
            expect(() => parseStackDescriptor(JSON.stringify({ hello: "world" }))).toThrow(StackConfigError)
        })

        it("rejects a malformed rpcUrl", () => {
            const stack = fakeStack()
            stack.rpcUrl = "not-a-url"

            expect(() => parseStackDescriptor(JSON.stringify(stack))).toThrow(StackConfigError)
        })

        it("rejects a malformed member serverUrl", () => {
            const stack = fakeStack()
            stack.members[0].serverUrl = "not-a-url"

            expect(() => parseStackDescriptor(JSON.stringify(stack))).toThrow(StackConfigError)
        })

        it("keeps a member's four brand colours and its scheme", () => {
            const parsed = parseStackDescriptor(JSON.stringify(fakeStack()))

            expect(parsed.members[0].brand).toEqual({
                accent: "#1d4ed8",
                onAccent: "#ffffff",
                accentSoft: "#dde6fb",
                accentInk: "#1d4ed8"
            })
            expect(parsed.members[0].scheme).toBe("member-a")
        })

        it("accepts a member with no scheme - a server-only org ships no app to name one", () => {
            const stack = fakeStack()
            delete stack.members[1].scheme

            expect(parseStackDescriptor(JSON.stringify(stack)).members[1].scheme).toBeUndefined()
        })

        it("rejects a brand colour that isn't #rrggbb", () => {
            const stack = fakeStack()
            stack.members[0].brand.accent = "blue"

            expect(() => parseStackDescriptor(JSON.stringify(stack))).toThrow(StackConfigError)
        })

        // The shape the testbed wrote before the network moved to one shared registry: the
        // revocation service alone, and a registry id on every member. The schema is strict, so a
        // stale stack.json fails here rather than on the first verification.
        it("rejects a descriptor from before the network had one shared registry", () => {
            const stack = fakeStack()
            const stale = {
                ...stack,
                revocation: { address: stack.revocation.address },
                members: stack.members.map((member) => ({ ...member, revocationRegistryId: "1" }))
            }

            expect(() => parseStackDescriptor(JSON.stringify(stale))).toThrow(StackConfigError)
        })

        it("rejects a member missing a brand", () => {
            const stack = fakeStack()
            // @ts-expect-error - the schema requires it, so only a hand-built stack can omit it.
            delete stack.members[0].brand

            expect(() => parseStackDescriptor(JSON.stringify(stack))).toThrow(StackConfigError)
        })
    })

    describe("resolvePairing", () => {
        const originalFetch = global.fetch

        afterEach(() => {
            global.fetch = originalFetch
        })

        it("fetches stack.json without the fragment and keeps the token from it", async () => {
            global.fetch = jest.fn(withStackJson()) as never

            await expect(resolvePairing(PAIRING_URL_A, "member-a")).resolves.toEqual(fakePairing())
            expect(global.fetch).toHaveBeenCalledWith("http://192.168.1.50:8080/stack.json")
        })

        it("refuses a pairing link for another member's slot, before fetching anything", async () => {
            global.fetch = jest.fn(withStackJson()) as never

            await expect(
                resolvePairing("http://192.168.1.50:8080/stack.json#org=1&token=member-token-b", "member-a")
            ).rejects.toThrow(/for member-b/)
            expect(global.fetch).not.toHaveBeenCalled()
        })

        it("explains that the public QR, or a pasted descriptor, is not a pairing link", async () => {
            global.fetch = jest.fn() as never

            await expect(resolvePairing("http://192.168.1.50:8080/stack.json", "member-a")).rejects.toThrow(
                /pairing QR/
            )
            await expect(resolvePairing(JSON.stringify(fakeStack()), "member-a")).rejects.toThrow(/pairing QR/)
            await expect(resolvePairing("http://192.168.1.50:8080/stack.json#org=0", "member-a")).rejects.toThrow(
                /pairing QR/
            )
            expect(global.fetch).not.toHaveBeenCalled()
        })

        it("answers a malformed fragment with a StackConfigError, not a URIError", async () => {
            global.fetch = jest.fn() as never

            await expect(
                resolvePairing("http://192.168.1.50:8080/stack.json#org=0&token=%zz", "member-a")
            ).rejects.toThrow(StackConfigError)
        })

        it("rejects a descriptor that still carries a token, which only a pre-#285 stack serves", async () => {
            const stale = fakeStack() as unknown as { members: Record<string, unknown>[] }
            stale.members[0].memberServerToken = "member-token-a"
            global.fetch = jest.fn(withStackJson(undefined, stale)) as never

            await expect(resolvePairing(PAIRING_URL_A, "member-a")).rejects.toThrow(StackConfigError)
        })

        it("rejects a failed fetch with the response status", async () => {
            global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => "" })) as never

            await expect(resolvePairing(PAIRING_URL_A, "member-a")).rejects.toThrow(/503/)
        })
    })

    describe("persistence", () => {
        it("returns null when nothing is stored", async () => {
            await clearStoredPairing()
            expect(await loadStoredPairing()).toBeNull()
        })

        it("round-trips a stored pairing", async () => {
            await storePairing(fakePairing())
            expect(await loadStoredPairing()).toEqual(fakePairing())
            await clearStoredPairing()
        })

        it("refuses what a pre-#285 build stored: the bare descriptor, every org's token in it", async () => {
            const stale = fakeStack() as unknown as { members: Record<string, unknown>[] }
            stale.members[0].memberServerToken = "member-token-a"
            await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stale))

            await expect(loadStoredPairing()).rejects.toThrow(/pairing QR again/)
            await clearStoredPairing()
        })
    })
})
