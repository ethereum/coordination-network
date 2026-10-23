import { BRANDS } from "@coordination-network/app-ui"
import type { PresentationReview } from "@coordination-network/user-app-core"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import ShareProof from "../ShareProof"
import type { ResolvedMember } from "../../members"
import { renderedText } from "../../test-text"

const memberB: ResolvedMember = { name: "Member B", brand: BRANDS.yellow }
const memberA: ResolvedMember = { name: "Member A", brand: BRANDS.blue }

const review: PresentationReview = {
    kind: "proof",
    verifier: "urn:cn:network:verifier",
    programme: "standard-access",
    country: "ZZZ",
    issuerNetworkId: `0x${"11".repeat(32)}`
}

const revoked: PresentationReview = { ...review, kind: "revoked" }

interface Handlers {
    onShare?: () => void
    onRefuse?: () => void
}

function shareProof(member: ResolvedMember | null, handlers: Handlers = {}, issuer: ResolvedMember | null = memberA) {
    return (
        <ShareProof
            review={review}
            member={member}
            issuer={issuer}
            callerName="Member B"
            onShare={handlers.onShare ?? jest.fn()}
            onRefuse={handlers.onRefuse ?? jest.fn()}
        />
    )
}

function shareRevoked(issuer: ResolvedMember | null, handlers: Handlers = {}) {
    return (
        <ShareProof
            review={revoked}
            member={memberB}
            issuer={issuer}
            callerName="Member B"
            onShare={handlers.onShare ?? jest.fn()}
            onRefuse={handlers.onRefuse ?? jest.fn()}
        />
    )
}

describe("ShareProof", () => {
    it("says it is ready to prove and what the verifier would learn from it", async () => {
        const tree = await renderScreen(shareProof(memberB))

        const text = allText(tree)
        expect(text).toContain("Ready to prove")
        expect(text).toContain("Shared with Member B")
        expect(text).toContain("You hold a valid standard-access credential")
        expect(text).toContain("Country ZZZ")
    })

    it("says what the verifier would not learn, which is the point of proving at all", async () => {
        const tree = await renderScreen(shareProof(memberB))

        const text = allText(tree)
        expect(text).toContain("Hidden from Member B")
        expect(text).toContain("Who you are")
        expect(text).toContain("Which member issued it")
        expect(text).toContain("Your other credentials")
        expect(text).toContain("Your network ID")
    })

    // Two members running the same programme means either of the person's credentials can answer,
    // and the wallet picks by expiry rather than by issuer - naming one is what would give the
    // issuer away. Saying which one answered is for the person, who is otherwise left unable to
    // tell this apart from a wallet that ignored a revocation.
    it("names which of the person's own credentials answered", async () => {
        const tree = await renderScreen(shareProof(memberB))

        expect(renderedText(tree)).toContain("Using your Member A credential.")
    })

    it("does not invent an issuer the loaded stack cannot place", async () => {
        const tree = await renderScreen(shareProof(memberB, {}, null))

        const text = renderedText(tree)
        expect(text).toContain("Using the credential you hold for this programme.")
        expect(text).not.toContain("Using your")
    })

    it("asks the question by name, and offers both answers", async () => {
        const tree = await renderScreen(shareProof(memberB))

        const text = allText(tree)
        expect(renderedText(tree)).toContain("Share the proof with Member B?")
        expect(text).toContain("Share")
        expect(text).toContain("Don't share")
    })

    it("shares on Share", async () => {
        const onShare = jest.fn()
        const tree = await renderScreen(shareProof(memberB, { onShare }))

        tree.root.findByProps({ testID: "share-proof" }).props.onPress()

        expect(onShare).toHaveBeenCalledTimes(1)
    })

    it("refuses on Don't share", async () => {
        const onRefuse = jest.fn()
        const tree = await renderScreen(shareProof(memberB, { onRefuse }))

        tree.root.findByProps({ testID: "share-refuse" }).props.onPress()

        expect(onRefuse).toHaveBeenCalledTimes(1)
    })

    it("names the verifier in its own ink, and only when the stack vouches for it", async () => {
        const matched = await renderScreen(shareProof(memberB))
        const unmatched = await renderScreen(shareProof(null))

        const inks = (tree: typeof matched) =>
            tree.root.findAll((node) => node.props.style?.color !== undefined).map((n) => n.props.style.color)
        expect(inks(matched)).toContain(BRANDS.yellow.accentInk)
        expect(inks(unmatched)).not.toContain(BRANDS.yellow.accentInk)
        expect(renderedText(unmatched)).toContain("Share the proof with Member B?")
    })
})

describe("ShareProof, on a revoked credential", () => {
    it("says who revoked what, and over which scope", async () => {
        const tree = await renderScreen(shareRevoked(memberA))

        const text = allText(tree)
        expect(text).toContain("Credential revoked")
        expect(renderedText(tree)).toContain(
            "Member A revoked your standard-access credential, so it can no longer prove anything."
        )
        expect(text).toContain("Programme")
        expect(text).toContain("standard-access")
        expect(text).toContain("Country")
        expect(text).toContain("ZZZ")
    })

    // The choice this screen used to offer was not cosmetic: refusing threw CONSENT_DENIED, which
    // the org app's `refusalCode` does not recognise, so the verifier was told nothing at all and
    // its request sat unresolved. One action, and the screen says what that action discloses.
    it("asks nothing, and says what telling the verifier reveals", async () => {
        const tree = await renderScreen(shareRevoked(memberA))

        const text = allText(tree)
        expect(text).not.toContain("Don't tell")
        expect(text).not.toContain("Tell Member B")
        expect(renderedText(tree)).toContain(
            "Member B is told the credential was revoked, so the check it asked for gets an answer."
        )
        expect(tree.root.findAllByProps({ testID: "share-refuse" }, { deep: false })).toHaveLength(0)
    })

    it("names the issuer in its own ink, and falls back to no member when the stack cannot place it", async () => {
        const matched = await renderScreen(shareRevoked(memberA))
        const unmatched = await renderScreen(shareRevoked(null))

        const inks = (tree: typeof matched) =>
            tree.root.findAll((node) => node.props.style?.color !== undefined).map((n) => n.props.style.color)
        expect(inks(matched)).toContain(BRANDS.blue.accentInk)
        expect(inks(unmatched)).not.toContain(BRANDS.blue.accentInk)
        expect(renderedText(unmatched)).toContain(
            "A network member revoked your standard-access credential, so it can no longer prove anything."
        )
    })

    it("tells the verifier on Done, which is what gives its check a verdict", async () => {
        const onShare = jest.fn()
        const tree = await renderScreen(shareRevoked(memberA, { onShare }))

        tree.root.findByProps({ testID: "revoked-ack" }).props.onPress()

        expect(onShare).toHaveBeenCalledTimes(1)
    })
})
