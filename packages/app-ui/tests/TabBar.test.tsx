import { SafeAreaProvider } from "react-native-safe-area-context"
import { press, renderScreen } from "@coordination-network/app-ui/testing"
import TabBar from "../src/components/TabBar"
import Icon from "../src/components/Icon"

const items = [
    { key: "home", label: "Home", icon: "credit-card" as const },
    { key: "settings", label: "Settings", icon: "settings" as const }
]

describe("TabBar", () => {
    it("gives the active item the accent colour and the rest the muted one", async () => {
        const tree = await renderScreen(<TabBar items={items} activeKey="settings" onSelect={jest.fn()} />)

        const home = tree.root.findByProps({ children: "Home" })
        const settings = tree.root.findByProps({ children: "Settings" })

        expect(settings.props.style.color).toBe("#176b4d")
        expect(home.props.style.color).toBe("#66716b")
    })

    it("calls onSelect with the pressed item's key", async () => {
        const onSelect = jest.fn()
        const tree = await renderScreen(<TabBar items={items} activeKey="home" onSelect={onSelect} />)

        await press(tree, 1)

        expect(onSelect).toHaveBeenCalledWith("settings")
    })

    it("draws one icon per item, coloured like its label", async () => {
        const tree = await renderScreen(<TabBar items={items} activeKey="home" onSelect={jest.fn()} />)

        const icons = tree.root.findAllByType(Icon)
        expect(icons.map((icon) => icon.props.name)).toEqual(["credit-card", "settings"])
        expect(icons[0]!.props.color).toBe("#176b4d")
        expect(icons[1]!.props.color).toBe("#66716b")
    })

    it("pads the bottom by the safe-area inset instead of a fixed gutter", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 320, height: 640 },
                    insets: { top: 0, right: 0, bottom: 34, left: 0 }
                }}
            >
                <TabBar items={items} activeKey="home" onSelect={jest.fn()} />
            </SafeAreaProvider>
        )

        const bar = tree.root.findByProps({ accessibilityRole: "tablist" })
        expect(bar.props.style.paddingBottom).toBe(34)
    })
})
