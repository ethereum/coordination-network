import { ScrollView, Text } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { renderScreen } from "@coordination-network/app-ui/testing"
import Screen from "../src/components/Screen"

const metrics = {
    frame: { x: 0, y: 0, width: 320, height: 640 },
    insets: { top: 47, right: 11, bottom: 34, left: 13 }
}

describe("Screen", () => {
    it("pads left and right by the safe-area insets but leaves the top inset to AppBar", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider initialMetrics={metrics}>
                <Screen>
                    <Text>Hello</Text>
                </Screen>
            </SafeAreaProvider>
        )

        // Host nodes only: the composite View and its host node carry the same style prop.
        const [container] = tree.root.findAll(
            (node) =>
                typeof node.type === "string" &&
                typeof node.props.style === "object" &&
                node.props.style !== null &&
                "paddingLeft" in node.props.style
        )
        expect(container.props.style.paddingTop).toBeUndefined()
        expect(container.props.style.paddingLeft).toBe(13)
        expect(container.props.style.paddingRight).toBe(11)
    })

    it("pads above its content, which is all that stands between the accent band and a title", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider initialMetrics={metrics}>
                <Screen>
                    <Text>Hello</Text>
                </Screen>
            </SafeAreaProvider>
        )

        const [content] = tree.root.findAll(
            (node) =>
                typeof node.type === "string" &&
                typeof node.props.style === "object" &&
                node.props.style !== null &&
                "paddingHorizontal" in node.props.style
        )
        expect(content.props.style.paddingTop).toBe(24)
    })

    it("renders a plain View, not a ScrollView, when scroll is left at its default", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider initialMetrics={metrics}>
                <Screen>
                    <Text>Hello</Text>
                </Screen>
            </SafeAreaProvider>
        )

        expect(tree.root.findAllByType(ScrollView)).toHaveLength(0)
    })

    it("wraps its children in a ScrollView, with the same content padding, when scroll is true", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider initialMetrics={metrics}>
                <Screen scroll>
                    <Text>Hello</Text>
                </Screen>
            </SafeAreaProvider>
        )

        const scrollViews = tree.root.findAllByType(ScrollView)
        expect(scrollViews).toHaveLength(1)
        expect(scrollViews[0].props.contentContainerStyle).toEqual({
            paddingHorizontal: 16,
            paddingTop: 24,
            paddingBottom: 24 + 16
        })
        expect(tree.root.findByProps({ children: "Hello" })).toBeTruthy()
    })
})
