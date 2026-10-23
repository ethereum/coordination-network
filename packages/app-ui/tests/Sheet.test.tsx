import { Text } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { renderScreen } from "@coordination-network/app-ui/testing"
import Sheet from "../src/components/Sheet"
import AppBar from "../src/components/AppBar"

describe("Sheet", () => {
    it("renders its children when visible", async () => {
        const tree = await renderScreen(
            <Sheet visible onRequestClose={jest.fn()}>
                <Text>Approve this request?</Text>
            </Sheet>
        )

        expect(tree.root.findByProps({ children: "Approve this request?" })).toBeTruthy()
    })

    it("renders nothing when not visible", async () => {
        const tree = await renderScreen(
            <Sheet visible={false} onRequestClose={jest.fn()}>
                <Text>Approve this request?</Text>
            </Sheet>
        )

        expect(() => tree.root.findByProps({ children: "Approve this request?" })).toThrow()
    })

    it("pads its content by the safe-area bottom inset", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 320, height: 640 },
                    insets: { top: 0, right: 0, bottom: 34, left: 0 }
                }}
            >
                <Sheet visible onRequestClose={jest.fn()}>
                    <Text>Approve this request?</Text>
                </Sheet>
            </SafeAreaProvider>
        )

        // Host nodes only: the composite Pressable and its host node carry the same style prop.
        const content = tree.root.find(
            (node) => typeof node.type === "string" && node.props.style?.paddingBottom === 16 + 34
        )
        expect(content).toBeTruthy()
    })

    it("renders the app bar above its children when brand is given", async () => {
        const tree = await renderScreen(
            <Sheet visible brand="Wallet" onRequestClose={jest.fn()}>
                <Text>Approve this request?</Text>
            </Sheet>
        )

        expect(tree.root.findAllByType(AppBar)).toHaveLength(1)
        expect(tree.root.findByProps({ children: "Wallet" })).toBeTruthy()
    })

    it("renders no app bar when brand is not given", async () => {
        const tree = await renderScreen(
            <Sheet visible onRequestClose={jest.fn()}>
                <Text>Approve this request?</Text>
            </Sheet>
        )

        expect(tree.root.findAllByType(AppBar)).toHaveLength(0)
    })

    it("renders its app bar in the compact variant, not the full one", async () => {
        const tree = await renderScreen(
            <Sheet visible brand="Wallet" onRequestClose={jest.fn()}>
                <Text>Approve this request?</Text>
            </Sheet>
        )

        const [bar] = tree.root.findAllByType(AppBar)
        expect(bar.props.compact).toBe(true)
    })
})
