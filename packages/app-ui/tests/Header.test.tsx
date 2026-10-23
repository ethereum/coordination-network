import { Text } from "react-native"
import { renderScreen } from "@coordination-network/app-ui/testing"
import Header from "../src/components/Header"

describe("Header", () => {
    it("renders no eyebrow when none is given", async () => {
        const tree = await renderScreen(<Header title="Identity" />)

        expect(() => tree.root.findByProps({ children: "Identity" })).not.toThrow()
    })

    it("renders no extra text node when neither an eyebrow nor a subtitle is given", async () => {
        const tree = await renderScreen(<Header title="Identity" />)

        expect(tree.root.findAllByType(Text)).toHaveLength(1)
    })

    it("renders the eyebrow in the muted colour, uppercased, above the title", async () => {
        const tree = await renderScreen(<Header eyebrow="Step 1 of 5" title="Identity" />)

        const eyebrow = tree.root.findByProps({ children: "Step 1 of 5" })
        expect(eyebrow.props.style.color).toBe("#66716b")
        expect(eyebrow.props.style.textTransform).toBe("uppercase")
        expect(eyebrow.props.style.letterSpacing).toBe(1)
    })
})
