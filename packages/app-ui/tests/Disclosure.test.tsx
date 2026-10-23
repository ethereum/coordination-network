import { Text } from "react-native"
import { allText, findPressables, press, renderScreen } from "@coordination-network/app-ui/testing"
import Disclosure from "../src/components/Disclosure"

describe("Disclosure", () => {
    it("hides its children until pressed, shows them after, and hides them again on a second press", async () => {
        const tree = await renderScreen(
            <Disclosure>
                <Text>0xabc123</Text>
            </Disclosure>
        )

        expect(allText(tree)).not.toContain("0xabc123")

        await press(tree)
        expect(allText(tree)).toContain("0xabc123")

        await press(tree)
        expect(allText(tree)).not.toContain("0xabc123")
    })

    it("labels the toggle 'Technical details' by default", async () => {
        const tree = await renderScreen(
            <Disclosure>
                <Text>0xabc123</Text>
            </Disclosure>
        )

        expect(tree.root.findByProps({ children: "Technical details" })).toBeTruthy()
    })

    it("uses a custom label when given", async () => {
        const tree = await renderScreen(
            <Disclosure label="Show raw values">
                <Text>0xabc123</Text>
            </Disclosure>
        )

        expect(tree.root.findByProps({ children: "Show raw values" })).toBeTruthy()
    })

    it("marks the toggle's accessibilityState.expanded, true only once opened", async () => {
        const tree = await renderScreen(
            <Disclosure>
                <Text>0xabc123</Text>
            </Disclosure>
        )

        const [toggle] = findPressables(tree)
        expect(toggle.props.accessibilityState).toEqual({ expanded: false })

        await press(tree)
        expect(toggle.props.accessibilityState).toEqual({ expanded: true })

        await press(tree)
        expect(toggle.props.accessibilityState).toEqual({ expanded: false })
    })

    it("passes testID through to the toggle", async () => {
        const tree = await renderScreen(
            <Disclosure testID="tech-details-toggle">
                <Text>0xabc123</Text>
            </Disclosure>
        )

        expect(tree.root.findByProps({ testID: "tech-details-toggle" })).toBeTruthy()
    })
})
