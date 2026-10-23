import { useState } from "react"
import type { JSX } from "react"
import { Pressable, Text, TextInput, View } from "react-native"
import {
    allText,
    changeText,
    findPressables,
    findTextInputs,
    press,
    renderScreen
} from "@coordination-network/app-ui/testing"

function Probe(): JSX.Element {
    const [count, setCount] = useState(0)
    const [name, setName] = useState("")

    return (
        <View>
            <Text>Count: {count}</Text>
            <Text>Name: {name}</Text>
            <Pressable onPress={() => setCount((current) => current + 1)}>
                <Text>Increment</Text>
            </Pressable>
            <TextInput value={name} onChangeText={setName} />
        </View>
    )
}

describe("testing helpers", () => {
    it("read text, press a pressable and type into a text input against a rendered tree", async () => {
        const tree = await renderScreen(<Probe />)

        expect(allText(tree)).toContain("Increment")
        expect(findPressables(tree)).toHaveLength(1)
        expect(findTextInputs(tree)).toHaveLength(1)

        await press(tree)
        expect(allText(tree)).toContain("Count: 1")

        await changeText(tree, 0, "member-a")
        expect(allText(tree)).toContain("Name: member-a")
    })
})
