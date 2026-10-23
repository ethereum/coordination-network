import { ActivityIndicator } from "react-native"
import { findPressables, press, renderScreen } from "@coordination-network/app-ui/testing"
import Button from "../src/components/Button"
import { palette } from "../src/tokens"

describe("Button", () => {
    it("ignores a press and shows a spinner instead of its label while loading", async () => {
        const onPress = jest.fn()
        const tree = await renderScreen(<Button testID="submit" label="Submit" onPress={onPress} loading />)

        await press(tree)

        expect(onPress).not.toHaveBeenCalled()
        expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1)
        expect(() => tree.root.findByProps({ children: "Submit" })).toThrow()
    })

    it("calls onPress and shows its label when not loading", async () => {
        const onPress = jest.fn()
        const tree = await renderScreen(<Button testID="submit" label="Submit" onPress={onPress} />)

        await press(tree)

        expect(onPress).toHaveBeenCalledTimes(1)
        expect(tree.root.findByProps({ children: "Submit" })).toBeTruthy()
    })

    it("uses the danger palette for the danger variant", async () => {
        const tree = await renderScreen(<Button testID="revoke" label="Revoke" onPress={jest.fn()} variant="danger" />)

        const [pressable] = findPressables(tree)
        expect(pressable.props.style.backgroundColor).toBe(palette.danger)
        expect(tree.root.findByProps({ children: "Revoke" }).props.style.color).toBe(palette.surface)
    })
})
