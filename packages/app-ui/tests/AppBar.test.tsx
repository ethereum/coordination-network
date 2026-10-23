import { Text } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { renderScreen } from "@coordination-network/app-ui/testing"
import { BRANDS, ThemeProvider } from "../src/tokens"
import AppBar from "../src/components/AppBar"

const metrics = {
    frame: { x: 0, y: 0, width: 320, height: 640 },
    insets: { top: 47, right: 0, bottom: 0, left: 0 }
}

describe("AppBar", () => {
    it("renders the name alone, coloured by the brand's accent", async () => {
        const tree = await renderScreen(
            <ThemeProvider brand={BRANDS.blue}>
                <AppBar name="Member A" />
            </ThemeProvider>
        )

        expect(tree.root.findAllByType(Text)).toHaveLength(1)
        expect(tree.root.findByProps({ children: "Member A" })).toBeTruthy()
        // Host nodes only: the composite View and its host node carry the same style prop.
        const band = tree.root.findAll(
            (node) => typeof node.type === "string" && node.props.style?.backgroundColor === "#1d4ed8"
        )
        expect(band.length).toBeGreaterThan(0)
    })

    it("pads the top by the safe-area inset in the full variant", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider initialMetrics={metrics}>
                <AppBar name="Member A" />
            </SafeAreaProvider>
        )

        const [band] = tree.root.findAll(
            (node) =>
                typeof node.type === "string" &&
                typeof node.props.style === "object" &&
                node.props.style !== null &&
                "paddingTop" in node.props.style
        )
        expect(band.props.style.paddingTop).toBeGreaterThanOrEqual(47)
    })

    it("renders one line and no top inset in the compact variant", async () => {
        const tree = await renderScreen(
            <SafeAreaProvider initialMetrics={metrics}>
                <AppBar compact name="Member A" />
            </SafeAreaProvider>
        )

        expect(tree.root.findAllByType(Text)).toHaveLength(1)
        expect(tree.root.findByProps({ children: "Member A" })).toBeTruthy()
        const withTopPadding = tree.root.findAll(
            (node) =>
                typeof node.type === "string" &&
                typeof node.props.style === "object" &&
                node.props.style !== null &&
                "paddingTop" in node.props.style
        )
        expect(withTopPadding).toHaveLength(0)
    })

    it("takes its text colour from the brand, so a light band carries dark ink", async () => {
        const white = await renderScreen(
            <ThemeProvider brand={BRANDS.red}>
                <AppBar name="Member C" />
            </ThemeProvider>
        )
        const dark = await renderScreen(
            <ThemeProvider brand={BRANDS.yellow}>
                <AppBar name="Member B" />
            </ThemeProvider>
        )

        expect(white.root.findByProps({ children: "Member C" }).props.style.color).toBe("#ffffff")
        expect(dark.root.findByProps({ children: "Member B" }).props.style.color).toBe("#17201c")
    })
})
