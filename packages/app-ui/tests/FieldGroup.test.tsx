import { View } from "react-native"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import { palette } from "../src/tokens"
import FieldGroup from "../src/components/FieldGroup"
import KeyValue from "../src/components/KeyValue"

/** Every row wrapper's own bottom border width, in render order. */
function ruleWidths(tree: Awaited<ReturnType<typeof renderScreen>>): unknown[] {
    return tree.root
        .findAllByType(View)
        .filter((node) => node.props.style?.borderBottomColor !== undefined)
        .map((node) => node.props.style.borderBottomWidth)
}

describe("FieldGroup", () => {
    it("rules between its rows, and not at either end", async () => {
        const tree = await renderScreen(
            <FieldGroup>
                <KeyValue label="Programme" value="demo-programme" truncate={false} />
                <KeyValue label="Country" value="ZZZ" truncate={false} />
                <KeyValue label="Valid" value="until 2027" truncate={false} />
            </FieldGroup>
        )

        expect(ruleWidths(tree)).toEqual([1, 1, 0])
    })

    it("draws its rules in the divider colour, not the panel outline's", async () => {
        const tree = await renderScreen(
            <FieldGroup>
                <KeyValue label="Programme" value="demo-programme" truncate={false} />
                <KeyValue label="Country" value="ZZZ" truncate={false} />
            </FieldGroup>
        )

        const colors = tree.root
            .findAllByType(View)
            .filter((node) => node.props.style?.borderBottomColor !== undefined)
            .map((node) => node.props.style.borderBottomColor)
        expect(colors).toEqual([palette.rule, palette.rule])
    })

    it("needs no rule for a single row", async () => {
        const tree = await renderScreen(
            <FieldGroup>
                <KeyValue label="Country" value="ZZZ" truncate={false} />
            </FieldGroup>
        )

        expect(ruleWidths(tree)).toEqual([0])
        expect(allText(tree)).toContain("ZZZ")
    })

    // A screen builds its rows with `condition ? <KeyValue/> : null`, and a dropped row must not
    // leave a rule behind it or a gap where it was.
    it("ignores a row a screen left out", async () => {
        const tree = await renderScreen(
            <FieldGroup>
                <KeyValue label="Programme" value="demo-programme" truncate={false} />
                {null}
                <KeyValue label="Country" value="ZZZ" truncate={false} />
            </FieldGroup>
        )

        expect(ruleWidths(tree)).toEqual([1, 0])
    })
})
