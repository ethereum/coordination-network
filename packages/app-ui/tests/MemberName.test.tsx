import { Text } from "react-native"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import { BRANDS } from "../src/tokens"
import MemberName from "../src/components/MemberName"

describe("MemberName", () => {
    it("renders the name bold, in the brand's ink", async () => {
        const tree = await renderScreen(<MemberName name="Member A" brand={BRANDS.blue} />)

        const name = tree.root.findByProps({ children: "Member A" })
        expect(name.props.style.color).toBe("#1d4ed8")
        expect(name.props.style.fontWeight).toBe("700")
    })

    it("uses the ink, not the accent, so a light brand stays readable on white", async () => {
        const tree = await renderScreen(<MemberName name="Member B" brand={BRANDS.yellow} />)

        expect(tree.root.findByProps({ children: "Member B" }).props.style.color).toBe("#8a5a00")
    })

    it("sizes up on request", async () => {
        const md = await renderScreen(<MemberName name="Member A" brand={BRANDS.blue} />)
        const xl = await renderScreen(<MemberName name="Member A" brand={BRANDS.blue} size="xl" />)

        const smaller = md.root.findByProps({ children: "Member A" }).props.style.fontSize
        const larger = xl.root.findByProps({ children: "Member A" }).props.style.fontSize
        expect(larger).toBeGreaterThan(smaller)
    })

    it("nests inside a sentence, so a consent line can name the member mid-text", async () => {
        const tree = await renderScreen(
            <Text>
                Share your identity with <MemberName name="Member A" brand={BRANDS.blue} /> to register.
            </Text>
        )

        expect(allText(tree)).toContain("Member A")
    })
})
