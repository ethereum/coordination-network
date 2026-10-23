import { BRANDS } from "@coordination-network/app-ui"
import { allText, press, renderScreen } from "@coordination-network/app-ui/testing"
import type { ConsentSummary } from "@coordination-network/user-app-core"
import Consent from "../Consent"
import type { ResolvedMember } from "../../members"
import { renderedText } from "../../test-text"

const CALLBACK = "memberapp://v1/response"

const memberA: ResolvedMember = { name: "Member A", brand: BRANDS.blue }

const registration: ConsentSummary = {
    op: "registration.sign",
    caller: { name: "Member A", scheme: "memberapp" },
    details: [
        { label: "Callback", value: CALLBACK, truncate: false },
        { label: "Registry contract", value: `0x${"11".repeat(20)}` },
        { label: "Chain ID", value: "31337" }
    ]
}

const issuance: ConsentSummary = {
    op: "credential.issue",
    caller: { name: "Member A", scheme: "memberapp" },
    scope: { programme: "standard-access", country: "ZZZ" },
    details: [
        { label: "Issuer", value: `0x${"11".repeat(32)}` },
        { label: "Programme", value: "standard-access" },
        { label: "Country", value: "ZZZ" },
        { label: "Callback", value: CALLBACK, truncate: false }
    ]
}

const presentation: ConsentSummary = {
    op: "presentation.create",
    caller: { name: "Member B", scheme: "memberb" },
    scope: { programme: "standard-access", country: "ZZZ" },
    details: [
        { label: "Verifier", value: "urn:cn:network:verifier" },
        { label: "Proof is sent to", value: "https://member.example/v1/verify" },
        { label: "Callback", value: CALLBACK, truncate: false },
        { label: "Programme", value: "standard-access" },
        { label: "Country", value: "ZZZ" }
    ]
}

// `Consent` is just the sheet's body (App owns the `Sheet` itself — see App.tsx). Its Pressable
// order is the Disclosure toggle, then Deny and Approve; an issuance also renders a StepList, whose
// idle steps carry no toggle of their own.
const DISCLOSURE_INDEX = 0
const DENY_INDEX = 1
const APPROVE_INDEX = 2

describe("Consent", () => {
    it("calls onApprove when Approve is pressed", async () => {
        const onApprove = jest.fn()
        const onDeny = jest.fn()
        const tree = await renderScreen(
            <Consent summary={registration} member={memberA} onApprove={onApprove} onDeny={onDeny} />
        )

        await press(tree, APPROVE_INDEX)

        expect(onApprove).toHaveBeenCalledTimes(1)
        expect(onDeny).not.toHaveBeenCalled()
    })

    it("calls onDeny when Deny is pressed", async () => {
        const onApprove = jest.fn()
        const onDeny = jest.fn()
        const tree = await renderScreen(
            <Consent summary={registration} member={memberA} onApprove={onApprove} onDeny={onDeny} />
        )

        await press(tree, DENY_INDEX)

        expect(onDeny).toHaveBeenCalledTimes(1)
        expect(onApprove).not.toHaveBeenCalled()
    })

    it("asks to share an identity in one sentence naming the org", async () => {
        const tree = await renderScreen(
            <Consent summary={registration} member={memberA} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        expect(allText(tree)).toContain("Share your identity")
        expect(renderedText(tree)).toContain(
            "Share your network ID and signature with Member A to register your identity on chain."
        )
    })

    it("asks to store a credential, and lists the three steps approving would run", async () => {
        const tree = await renderScreen(
            <Consent summary={issuance} member={memberA} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        const text = allText(tree)
        expect(text).toContain("Store a credential")
        expect(renderedText(tree)).toContain("Member A is issuing you a standard-access credential for ZZZ.")
        expect(text).toContain("Checking your credential status")
        expect(text).toContain("Binding the credential")
        expect(text).toContain("Storing the credential")
    })

    it("asks to prove with a credential in one sentence naming the verifier", async () => {
        const memberB: ResolvedMember = { name: "Member B", brand: BRANDS.yellow }
        const tree = await renderScreen(
            <Consent summary={presentation} member={memberB} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        expect(allText(tree)).toContain("Prove with your credential")
        expect(renderedText(tree)).toContain("Prove to Member B that you hold a standard-access credential for ZZZ.")
    })

    it("draws a matched org's name in the org's own ink", async () => {
        const tree = await renderScreen(
            <Consent summary={registration} member={memberA} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        const inks = tree.root.findAll((node) => node.props.style?.color !== undefined).map((n) => n.props.style.color)
        expect(inks).toContain(BRANDS.blue.accentInk)
    })

    it("leaves an unmatched caller its own name in plain ink, so it cannot borrow a member's colour", async () => {
        const tree = await renderScreen(
            <Consent
                summary={{ ...registration, caller: { name: "Member A", scheme: "impostor" } }}
                member={null}
                onApprove={jest.fn()}
                onDeny={jest.fn()}
            />
        )

        const inks = tree.root.findAll((node) => node.props.style?.color !== undefined).map((n) => n.props.style.color)
        expect(renderedText(tree)).toContain(
            "Share your network ID and signature with Member A to register your identity on chain."
        )
        expect(inks).not.toContain(BRANDS.blue.accentInk)
    })

    it("shows the callback up front when nothing in the stack vouches for the caller", async () => {
        const tree = await renderScreen(
            <Consent summary={presentation} member={null} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        const before = allText(tree)
        expect(before).toContain("Callback")
        expect(before.join(" ")).toContain(CALLBACK)
        // Only the callback comes forward; the rest still waits behind the toggle, which the
        // callback row's own (disabled) Pressable now sits ahead of.
        expect(before).not.toContain("Verifier")

        await press(tree, DISCLOSURE_INDEX + 1)

        expect(allText(tree)).toContain("Verifier")
    })

    it("folds every technical value away, the callback included, until the disclosure is pressed", async () => {
        const memberB: ResolvedMember = { name: "Member B", brand: BRANDS.yellow }
        const tree = await renderScreen(
            <Consent summary={presentation} member={memberB} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        const before = allText(tree)
        expect(before).not.toContain("Verifier")
        expect(before).not.toContain("Callback")
        expect(before.join(" ")).not.toContain(CALLBACK)

        await press(tree, DISCLOSURE_INDEX)

        const after = allText(tree)
        expect(after).toContain("Verifier")
        expect(after).toContain("Proof is sent to")
        expect(after).toContain("Callback")
        expect(after).toContain("Programme")
        expect(after).toContain("Country")
    })

    it("never shortens the callback, the one value a spoofed caller would change", async () => {
        const tree = await renderScreen(
            <Consent summary={registration} member={memberA} onApprove={jest.fn()} onDeny={jest.fn()} />
        )

        await press(tree, DISCLOSURE_INDEX)

        expect(allText(tree)).toContain(CALLBACK)
    })

    it("never clips a sentence, however long the org's name runs", async () => {
        const tree = await renderScreen(
            <Consent
                summary={{
                    ...registration,
                    caller: { name: "An Org With A Much Longer Display Name", scheme: "longname" }
                }}
                member={null}
                onApprove={jest.fn()}
                onDeny={jest.fn()}
            />
        )

        const clipped = tree.root.findAll((node) => typeof node.props.numberOfLines === "number")
        expect(clipped).toEqual([])
    })
})
