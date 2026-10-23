import { renderScreen } from "@coordination-network/app-ui/testing"
import { BRANDS, fonts, MONO_FACE, SANS_FACES, ThemeProvider } from "../src/tokens"
import AppBar from "../src/components/AppBar"
import Badge from "../src/components/Badge"
import Button from "../src/components/Button"
import Header from "../src/components/Header"
import KeyValue from "../src/components/KeyValue"

describe("ThemeProvider", () => {
    it("merges a brand's four colours into the palette a component reads from useTheme", async () => {
        const tree = await renderScreen(
            <ThemeProvider brand={BRANDS.blue}>
                <Badge label="Member A" tone="accent" />
            </ThemeProvider>
        )

        const text = tree.root.findByProps({ children: "Member A" })
        expect(text.props.style.color).toBe("#1d4ed8")
    })

    it("tints an accent badge without rewriting the colour string, so any format works", async () => {
        const brand = { ...BRANDS.blue, accentInk: "rgb(51, 85, 255)" }
        const tree = await renderScreen(
            <ThemeProvider brand={brand}>
                <Badge label="Member A" tone="accent" />
            </ThemeProvider>
        )

        const text = tree.root.findByProps({ children: "Member A" })
        expect(text.props.style.color).toBe("rgb(51, 85, 255)")
        // Host nodes only: the composite View and its host node carry the same props.
        const tint = tree.root.findAll(
            (node) => typeof node.type === "string" && node.props.style?.backgroundColor === "rgb(51, 85, 255)"
        )
        expect(tint).toHaveLength(1)
        expect(tint[0].props.style.opacity).toBeLessThan(1)
    })

    it("falls back to the green brand with no override", async () => {
        const tree = await renderScreen(<Badge label="User" tone="accent" />)

        const text = tree.root.findByProps({ children: "User" })
        expect(text.props.style.color).toBe("#176b4d")
    })

    it("draws accent text in the ink, not the accent, so a light brand stays readable on white", async () => {
        const tree = await renderScreen(
            <ThemeProvider brand={BRANDS.yellow}>
                <Badge label="Member B" tone="accent" />
            </ThemeProvider>
        )

        const text = tree.root.findByProps({ children: "Member B" })
        expect(text.props.style.color).toBe("#8a5a00")
    })

    it("draws text on an accent surface in onAccent, so a light brand carries dark ink", async () => {
        const tree = await renderScreen(
            <ThemeProvider brand={BRANDS.yellow}>
                <AppBar name="Member B" />
                <Button label="Register" onPress={() => {}} />
            </ThemeProvider>
        )

        expect(tree.root.findByProps({ children: "Member B" }).props.style.color).toBe("#17201c")
        expect(tree.root.findByProps({ children: "Register" }).props.style.color).toBe("#17201c")
    })

    // Text has to render on the first frame, before any face has loaded, so an unloaded theme
    // names no family at all and the platform's own is used.
    it("names no face until the app says its fonts are loaded", async () => {
        const tree = await renderScreen(<Header title="Credentials" />)

        expect(tree.root.findByProps({ children: "Credentials" }).props.style.fontFamily).toBeUndefined()
    })

    it("carries the face for the weight a style asks for, once loaded", async () => {
        const tree = await renderScreen(
            <ThemeProvider fontsLoaded>
                <Header title="Credentials" subtitle="Two held" />
            </ThemeProvider>
        )

        // The title is bold, the subtitle is not: one family each, not one family plus a
        // `fontWeight` Android would synthesise a bold from.
        expect(tree.root.findByProps({ children: "Credentials" }).props.style.fontFamily).toBe(SANS_FACES["700"])
        expect(tree.root.findByProps({ children: "Two held" }).props.style.fontFamily).toBe(SANS_FACES["400"])
    })

    it("swaps the platform's monospace for Plex Mono once loaded, and not before", async () => {
        const unloaded = await renderScreen(<KeyValue label="Credential id" value="urn:uuid:1" mono />)
        const loaded = await renderScreen(
            <ThemeProvider fontsLoaded>
                <KeyValue label="Credential id" value="urn:uuid:1" mono />
            </ThemeProvider>
        )

        expect(unloaded.root.findByProps({ children: "urn:uuid:1" }).props.style.fontFamily).toBe(fonts.mono)
        expect(loaded.root.findByProps({ children: "urn:uuid:1" }).props.style.fontFamily).toBe(MONO_FACE)
    })
})
