import { BRANDS } from "@coordination-network/app-ui"
import { resolveIssuer, resolveMember, shortNetworkId } from "../members"
import { testMember, testStack } from "../test-stack"

const stack = testStack([
    testMember(),
    testMember({ name: "Member B", networkId: `0x${"22".repeat(32)}`, brand: BRANDS.yellow, scheme: "memberb" })
])

describe("resolveMember", () => {
    it("names the member, and its colour, when the name matches and the callback is that member's scheme", () => {
        expect(resolveMember(stack, { name: "Member A", scheme: "memberapp" }, "memberapp://v1/response")).toEqual({
            name: "Member A",
            brand: BRANDS.blue
        })
    })

    it("refuses a caller that borrows a member's name but is answered on another scheme", () => {
        expect(resolveMember(stack, { name: "Member A", scheme: "memberapp" }, "impostor://v1/response")).toBeNull()
    })

    it("refuses a caller answered on a member's scheme under another name", () => {
        expect(
            resolveMember(stack, { name: "Not Member A", scheme: "memberapp" }, "memberapp://v1/response")
        ).toBeNull()
    })

    it("goes by the callback the OS will open, not the scheme the caller claims", () => {
        expect(resolveMember(stack, { name: "Member A", scheme: "impostor" }, "memberapp://v1/response")).toEqual({
            name: "Member A",
            brand: BRANDS.blue
        })
    })

    it("reads the scheme case-insensitively, as the OS does", () => {
        expect(resolveMember(stack, { name: "Member A", scheme: "memberapp" }, "MemberApp://v1/response")).toEqual({
            name: "Member A",
            brand: BRANDS.blue
        })
    })

    it("resolves nothing before a stack is loaded, so no caller is coloured", () => {
        expect(resolveMember(null, { name: "Member A", scheme: "memberapp" }, "memberapp://v1/response")).toBeNull()
    })

    // A member with no scheme of its own registers nothing for the OS to route a response to, so
    // there is no callback that could stand for it.
    it("refuses a member the stack lists without a scheme, whatever the callback", () => {
        const schemeless = testStack([testMember({ scheme: undefined })])

        expect(
            resolveMember(schemeless, { name: "Member A", scheme: "memberapp" }, "memberapp://v1/response")
        ).toBeNull()
    })

    it("refuses a callback with no scheme at all, even under a member's own name", () => {
        expect(resolveMember(stack, { name: "Member A", scheme: "memberapp" }, "/v1/response")).toBeNull()
    })
})

describe("resolveIssuer", () => {
    it("names the member holding that network id", () => {
        expect(resolveIssuer(stack, `0x${"22".repeat(32)}`)).toEqual({ name: "Member B", brand: BRANDS.yellow })
    })

    it("resolves nothing for a network id the loaded stack has never heard of", () => {
        expect(resolveIssuer(stack, `0x${"99".repeat(32)}`)).toBeNull()
    })
})

describe("shortNetworkId", () => {
    it("keeps the head and tail a person would compare", () => {
        expect(shortNetworkId(`0x${"ab".repeat(32)}`)).toBe("0xabab…abab")
    })
})
