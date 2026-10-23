import { Text } from "react-native"
import { renderScreen } from "@coordination-network/app-ui/testing"
import { BRANDS, palette } from "../src/tokens"
import Card from "../src/components/Card"

function stripesOf(tree: Awaited<ReturnType<typeof renderScreen>>) {
    return tree.root.findAll(
        (node) => typeof node.type === "string" && typeof node.props.style?.borderLeftWidth === "number"
    )
}

describe("Card", () => {
    it("renders its title and children", async () => {
        const tree = await renderScreen(
            <Card title="Credential">
                <Text>demo-2026</Text>
            </Card>
        )

        expect(tree.root.findByProps({ children: "Credential" })).toBeTruthy()
        expect(tree.root.findByProps({ children: "demo-2026" })).toBeTruthy()
    })

    it("draws no left stripe without an accent", async () => {
        const tree = await renderScreen(
            <Card>
                <Text>demo-2026</Text>
            </Card>
        )

        expect(stripesOf(tree)).toHaveLength(0)
    })

    it("draws a left stripe in the accent of the brand it is given", async () => {
        const tree = await renderScreen(
            <Card brand={BRANDS.blue}>
                <Text>demo-2026</Text>
            </Card>
        )

        const [stripe] = stripesOf(tree)
        expect(stripe.props.style.borderLeftWidth).toBe(6)
        expect(stripe.props.style.borderLeftColor).toBe(BRANDS.blue.accent)
    })

    // A stripe alone reads as a plain white card from any distance, so the brand also tints the
    // band its header sits in.
    it("tints the header band with the brand, and leaves the body on paper", async () => {
        const tree = await renderScreen(
            <Card brand={BRANDS.yellow} header={<Text>Member B</Text>}>
                <Text>demo-2026</Text>
            </Card>
        )

        const tinted = tree.root.findAll(
            (node) => typeof node.type === "string" && node.props.style?.backgroundColor === BRANDS.yellow.accentSoft
        )
        expect(tinted).toHaveLength(1)
        expect(tree.root.findByProps({ children: "Member B" })).toBeTruthy()
    })

    it("recesses a header band when no brand names the record", async () => {
        const tree = await renderScreen(
            <Card header={<Text>0x1111…1111</Text>}>
                <Text>demo-2026</Text>
            </Card>
        )

        const recessed = tree.root.findAll(
            (node) => typeof node.type === "string" && node.props.style?.backgroundColor === palette.canvas
        )
        expect(recessed).toHaveLength(1)
    })

    // Whose credential it is outlives its cancellation, and once a credential is revoked the only
    // card on screen from that issuer is the revoked one - so trading its colour for red loses the
    // very thing the colour is there to say. The wash and the badge carry "cancelled" instead.
    it("keeps the issuer's stripe when voided, rather than replacing it with danger", async () => {
        const tree = await renderScreen(
            <Card brand={BRANDS.blue} voided>
                <Text>demo-2026</Text>
            </Card>
        )

        const [stripe] = stripesOf(tree)
        expect(stripe.props.style.borderLeftColor).toBe(BRANDS.blue.accent)
        expect(stripe.props.style.borderColor).toBe(palette.line)
    })

    it("washes a voided card's surface, and leaves an ordinary one clean", async () => {
        const washes = (tree: Awaited<ReturnType<typeof renderScreen>>) =>
            tree.root.findAll(
                (node) =>
                    // Host nodes only: RN's View is a composite that renders one, so an unfiltered
                    // search counts the same layer twice - as stripesOf above does too.
                    typeof node.type === "string" &&
                    node.props.style?.backgroundColor === palette.danger &&
                    node.props.style?.opacity === 0.06
            )

        const voided = await renderScreen(
            <Card voided>
                <Text>demo-2026</Text>
            </Card>
        )
        const live = await renderScreen(
            <Card>
                <Text>demo-2026</Text>
            </Card>
        )

        expect(washes(voided)).toHaveLength(1)
        expect(washes(live)).toHaveLength(0)
    })

    it("falls back to a danger stripe on a voided card with no brand to carry one", async () => {
        const tree = await renderScreen(
            <Card voided>
                <Text>demo-2026</Text>
            </Card>
        )

        const [stripe] = stripesOf(tree)
        expect(stripe.props.style.borderLeftWidth).toBe(6)
        expect(stripe.props.style.borderLeftColor).toBe(palette.danger)
    })
})
