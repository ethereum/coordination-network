import { allText, findPressables, press, renderScreen } from "@coordination-network/app-ui/testing"
import KeyValue from "../src/components/KeyValue"
import Icon from "../src/components/Icon"

const LONG_HASH = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("KeyValue", () => {
    it("shows a long value middle-truncated by default", async () => {
        const tree = await renderScreen(<KeyValue label="Root" value={LONG_HASH} />)

        expect(tree.root.findByProps({ selectable: true }).props.children).toBe("0x1234…cdef")
    })

    it("expands to the full value on tap", async () => {
        const tree = await renderScreen(<KeyValue label="Root" value={LONG_HASH} />)

        await press(tree)

        expect(tree.root.findByProps({ selectable: true }).props.children).toBe(LONG_HASH)
    })

    it("shows a short value as-is, with nothing to expand", async () => {
        const tree = await renderScreen(<KeyValue label="Country" value="ZZ" />)

        expect(tree.root.findByProps({ selectable: true }).props.children).toBe("ZZ")
    })

    it("shows a long value in full when truncation is turned off", async () => {
        const tree = await renderScreen(<KeyValue label="Callback" value={LONG_HASH} truncate={false} />)

        expect(tree.root.findByProps({ selectable: true }).props.children).toBe(LONG_HASH)
    })

    it("shows no hint icon for a row without one", async () => {
        const tree = await renderScreen(<KeyValue label="Country" value="ZZ" />)

        expect(tree.root.findAllByType(Icon)).toHaveLength(0)
    })

    it("toggles a hint line under the value", async () => {
        const tree = await renderScreen(
            <KeyValue label="Network ID" value="ZZ" hint="Your public name on the network." />
        )

        expect(tree.root.findByType(Icon).props.name).toBe("info")
        expect(allText(tree)).not.toContain("Your public name on the network.")

        await press(tree, 0)
        expect(allText(tree)).toContain("Your public name on the network.")

        await press(tree, 0)
        expect(allText(tree)).not.toContain("Your public name on the network.")
    })

    it("names the hint toggle for a screen reader and marks whether it is open", async () => {
        const tree = await renderScreen(
            <KeyValue label="Network ID" value="ZZ" hint="Your public name on the network." />
        )

        const [toggle] = findPressables(tree)
        expect(toggle.props.accessibilityLabel).toBe("About Network ID")
        expect(toggle.props.accessibilityState).toEqual({ expanded: false })

        await press(tree, 0)
        expect(toggle.props.accessibilityState).toEqual({ expanded: true })
    })
})
