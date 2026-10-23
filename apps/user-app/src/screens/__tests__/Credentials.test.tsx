import { act } from "react-test-renderer"
import type { ReactTestRenderer } from "react-test-renderer"
import { RefreshControl } from "react-native"
import { BRANDS, palette } from "@coordination-network/app-ui"
import type { HeldCredential, UserAppService } from "@coordination-network/user-app-core"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import CredentialsScreen from "../Credentials"
import { testMember, testStack } from "../../test-stack"

/** The card's own disclosure, by `testID` rather than by position: every labelled field renders a
 *  `Pressable` of its own, so an index would move whenever a row is added. */
async function openDetails(tree: ReactTestRenderer, index = 0): Promise<void> {
    const toggles = tree.root.findAll(
        (node) => node.props.testID === "credential-details" && typeof node.props.onPress === "function"
    )
    await act(async () => {
        await toggles[index].props.onPress()
    })
}

async function pullToRefresh(tree: ReactTestRenderer): Promise<void> {
    await act(async () => {
        await tree.root.findByType(RefreshControl).props.onRefresh()
    })
}

/** Every value a rendered style gives `key`, for asserting on a colour rather than a string. */
function styleValues(tree: ReactTestRenderer, key: string): unknown[] {
    return tree.root.findAll((node) => node.props.style?.[key] !== undefined).map((node) => node.props.style[key])
}

function fakeService(credentials: HeldCredential[], onboarded = true): UserAppService {
    return {
        handlers: {},
        consent: async () => true,
        isOnboarded: async () => onboarded,
        createIdentity: async () => {
            throw new Error("not used in this screen")
        },
        readIdentity: async () => {
            throw new Error("not used in this screen")
        },
        listCredentials: async () => credentials,
        readStealthScanKeys: async () => {
            throw new Error("not used in this screen")
        },
        erase: async () => undefined,
        removeUnboundCredentials: async () => 0
    }
}

const memberA = testMember()
const stack = testStack([memberA])

const held: HeldCredential = {
    id: "cred-1",
    status: "valid",
    issuerNetworkId: memberA.networkId,
    programme: "standard-access",
    issuedAt: 1_760_000_000,
    programmeHash: "0xabc123456789",
    country: "ZZZ",
    notBefore: 0,
    expiresAt: 4_000_000_000
}

const fromAnUnknownOrg: HeldCredential = {
    ...held,
    id: "cred-2",
    status: "expired",
    issuerNetworkId: `0x${"99".repeat(32)}`,
    programme: "priority-access",
    programmeHash: "0xdef123456789",
    country: "XAA",
    expiresAt: 1
}

describe("CredentialsScreen", () => {
    it("points a person with no identity at the first step instead", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([], false)} stack={stack} />)

        const text = allText(tree)
        expect(text).toContain("No credentials yet")
        expect(text).toContain("Create your identity first.")
    })

    it("says where a credential comes from once there is an identity to issue one to", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([])} stack={stack} />)

        const text = allText(tree)
        expect(text).toContain("No credentials yet")
        expect(text).toContain("An org issues one after you register.")
    })

    it("names every field it shows, so a value like ZZZ is not left to be guessed at", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([held])} stack={stack} />)

        const text = allText(tree)
        expect(text).toContain("Member A")
        expect(text).toContain("Programme")
        expect(text).toContain("standard-access")
        expect(text).toContain("Country")
        expect(text).toContain("ZZZ")
        expect(text).toContain("Valid")
        expect(text.some((line) => line.includes("–"))).toBe(true)
        expect(text).toContain("Technical details")
        expect(text).not.toContain("Programme hash")
    })

    it("explains what each field is, behind its own info icon", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([held])} stack={stack} />)

        const hint = tree.root.find(
            (node) => node.props.accessibilityLabel === "About Country" && typeof node.props.onPress === "function"
        )
        expect(allText(tree)).not.toContain("Where the programme runs, as a three-letter country code.")

        await act(async () => {
            await hint.props.onPress()
        })

        expect(allText(tree)).toContain("Where the programme runs, as a three-letter country code.")
    })

    // A stripe and a coloured name on a near-white card read as black on white from any distance,
    // so the band the org's name sits in is tinted too.
    it("draws the org's own colour, its stripe and its tint, from the stack", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([held])} stack={stack} />)

        expect(styleValues(tree, "color")).toContain(BRANDS.blue.accentInk)
        expect(styleValues(tree, "borderLeftColor")).toContain(BRANDS.blue.accent)
        expect(styleValues(tree, "backgroundColor")).toContain(BRANDS.blue.accentSoft)
    })

    it("reveals the credential id, the programme hash and the issuer's network id on request", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([held])} stack={stack} />)

        await openDetails(tree)

        const text = allText(tree)
        expect(text).toContain("Credential id")
        expect(text).toContain("Programme hash")
        expect(text).toContain("Issuer network ID")
    })

    it("shortens an issuer the loaded stack cannot name, and gives it no colour", async () => {
        const tree = await renderScreen(<CredentialsScreen service={fakeService([fromAnUnknownOrg])} stack={stack} />)

        expect(allText(tree)).toContain("0x9999…9999")
        expect(styleValues(tree, "borderLeftColor")).toEqual([])
        expect(styleValues(tree, "color")).not.toContain(BRANDS.blue.accentInk)
        expect(styleValues(tree, "color")).toContain(palette.ink)
    })

    it("shows a card per held credential, whoever issued it", async () => {
        const tree = await renderScreen(
            <CredentialsScreen service={fakeService([held, fromAnUnknownOrg])} stack={stack} />
        )

        const text = allText(tree)
        expect(text).toContain("Valid")
        expect(text).toContain("Expired")
        expect(text).toContain("priority-access")
        expect(text).toContain("XAA")
    })

    it("says a credential the network has revoked is revoked", async () => {
        const revoked: HeldCredential = { ...held, status: "revoked" }
        const tree = await renderScreen(<CredentialsScreen service={fakeService([revoked])} stack={stack} />)

        // "Valid" is still on the card, as the label of the validity window; the badge is what
        // says the credential itself is finished, so this checks the badge's own colour.
        expect(allText(tree)).toContain("Revoked")
        expect(styleValues(tree, "color")).toContain(palette.danger)
        // The stripe keeps the issuer's colour to say who issued it; the danger wash says cancelled.
        expect(styleValues(tree, "borderLeftColor")).toContain(BRANDS.blue.accent)
        expect(styleValues(tree, "backgroundColor")).toContain(palette.danger)
    })

    // An unchecked credential is inside its window with nothing to confirm it is still live.
    // Reporting it as "Valid" would be a claim the wallet cannot make.
    it("says it has not checked, and how to let it, when no stack is loaded", async () => {
        const unchecked: HeldCredential = { ...held, status: "unchecked" }
        const tree = await renderScreen(<CredentialsScreen service={fakeService([unchecked])} stack={null} />)

        const text = allText(tree)
        expect(text).toContain("Not checked")
        expect(text).toContain("Load a stack on the Config tab to check whether this is still live.")
    })

    it("says the network could not be reached when a stack is loaded but unreachable", async () => {
        const unchecked: HeldCredential = { ...held, status: "unchecked" }
        const tree = await renderScreen(<CredentialsScreen service={fakeService([unchecked])} stack={stack} />)

        const text = allText(tree)
        expect(text).toContain("Not checked")
        expect(text).toContain("The network could not be reached to check whether this is still live.")
    })

    // A revocation happens on the dashboard, so the phone is never told. Re-reading has to be
    // something the person can ask for.
    it("re-reads the listing when pulled to refresh, so a revocation elsewhere shows up", async () => {
        let current: HeldCredential[] = [held]
        const service = fakeService([])
        const tree = await renderScreen(
            <CredentialsScreen service={{ ...service, listCredentials: async () => current }} stack={stack} />
        )
        expect(allText(tree)).toContain("Valid")

        current = [{ ...held, status: "revoked" }]
        await pullToRefresh(tree)

        expect(allText(tree)).toContain("Revoked")
    })
})
