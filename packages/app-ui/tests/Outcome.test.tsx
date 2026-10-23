import { Text } from "react-native"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import { BRANDS, ThemeProvider } from "../src/tokens"
import Icon from "../src/components/Icon"
import Outcome from "../src/components/Outcome"

describe("Outcome", () => {
    it("renders its icon, title and lines", async () => {
        const tree = await renderScreen(
            <Outcome tone="success" icon="check-circle" title="Registered" lines={["Not counted twice"]} />
        )

        expect(tree.root.findByType(Icon).props.name).toBe("check-circle")
        expect(allText(tree)).toContain("Registered")
        expect(allText(tree)).toContain("Not counted twice")
    })

    it("renders one line per line given, and none otherwise", async () => {
        const bare = await renderScreen(<Outcome tone="success" icon="check-circle" title="Registered" />)
        const withLines = await renderScreen(
            <Outcome
                tone="success"
                icon="check-circle"
                title="Registered"
                lines={["Matches this device", "Not counted twice"]}
            />
        )

        // The icon draws its glyph in a Text of its own, so count the difference, not the total.
        expect(withLines.root.findAllByType(Text).length - bare.root.findAllByType(Text).length).toBe(2)
    })

    it("colours the icon by tone", async () => {
        const success = await renderScreen(<Outcome tone="success" icon="check-circle" title="Eligible" />)
        const danger = await renderScreen(<Outcome tone="danger" icon="x-circle" title="Not eligible" />)

        expect(success.root.findByType(Icon).props.color).toBe("#2f8f5b")
        expect(danger.root.findByType(Icon).props.color).toBe("#a33b32")
    })

    it("draws a neutral outcome in the brand's ink", async () => {
        const tree = await renderScreen(
            <ThemeProvider brand={BRANDS.yellow}>
                <Outcome tone="neutral" icon="users" title="Already registered" />
            </ThemeProvider>
        )

        expect(tree.root.findByType(Icon).props.color).toBe("#8a5a00")
    })

    it("renders children under the lines", async () => {
        const tree = await renderScreen(
            <Outcome tone="success" icon="check-circle" title="Registered" testID="register-outcome">
                <Text>Gas paid by the paymaster</Text>
            </Outcome>
        )

        expect(allText(tree)).toContain("Gas paid by the paymaster")
        expect(tree.root.findByProps({ testID: "register-outcome" })).toBeTruthy()
    })

    // `testID` reaches the rendered `Animated.View` too, so filter out the `Outcome` element
    // itself - the only layer whose own `entering` prop is the raw one passed in, rather than
    // the animation Reanimated actually runs.
    function animatedView(tree: Awaited<ReturnType<typeof renderScreen>>) {
        return tree.root.findAll((node) => node.props.testID === "register-outcome" && node.type !== Outcome)[0]
    }

    it("plays its own mount entrance by default", async () => {
        const tree = await renderScreen(
            <Outcome tone="success" icon="check-circle" title="Registered" testID="register-outcome" />
        )

        expect(animatedView(tree).props.entering).toBeDefined()
    })

    it("skips the mount entrance when entering is false, for a body that already animates in", async () => {
        const tree = await renderScreen(
            <Outcome tone="success" icon="check-circle" title="Registered" testID="register-outcome" entering={false} />
        )

        expect(animatedView(tree).props.entering).toBeUndefined()
    })
})
