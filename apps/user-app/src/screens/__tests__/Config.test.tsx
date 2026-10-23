import mockAsyncStorage from "@react-native-async-storage/async-storage/jest/async-storage-mock"

jest.mock("@react-native-async-storage/async-storage", () => mockAsyncStorage)
jest.mock("expo-camera", () => ({
    CameraView: () => null,
    useCameraPermissions: () => [{ granted: true }, jest.fn()]
}))

import { act } from "react-test-renderer"
import { CameraView } from "expo-camera"
import { BRANDS } from "@coordination-network/app-ui"
import { allText, changeText, press, renderScreen } from "@coordination-network/app-ui/testing"
import ConfigScreen from "../Config"
import { testMember, testStack } from "../../test-stack"

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

const stack = testStack([
    testMember({ name: "Member A" }),
    testMember({ name: "Member B", networkId: `0x${"55".repeat(32)}`, brand: BRANDS.yellow, role: "candidate" })
])

describe("ConfigScreen", () => {
    it("shows the empty state before a stack is loaded", async () => {
        const tree = await renderScreen(<ConfigScreen stack={null} onSaved={jest.fn()} />)

        expect(allText(tree)).toContain("No stack configured yet")
    })

    it("shows a summary of the current stack once loaded, members and roles included in words", async () => {
        const tree = await renderScreen(<ConfigScreen stack={stack} onSaved={jest.fn()} />)

        const text = allText(tree)
        expect(text).toContain("Current stack")
        expect(text).toContain("Member A (founding org)")
        expect(text).toContain("Member B (candidate)")
        // `KeyValue` truncates a value this long by default, so only its head survives.
        expect(text.some((line) => line.startsWith(stack.dashboardUrl.slice(0, 6)))).toBe(true)
    })

    it("parses and saves a pasted stack.json", async () => {
        const onSaved = jest.fn()
        const tree = await renderScreen(<ConfigScreen stack={null} onSaved={onSaved} />)

        await changeText(tree, 0, JSON.stringify(stack))
        await press(tree, 1) // scan-stack (0) precedes save-pasted (1) in render order

        expect(onSaved).toHaveBeenCalledWith(stack)
    })

    it("saves once when two frames decode before scanning=false commits", async () => {
        const onSaved = jest.fn()
        const tree = await renderScreen(<ConfigScreen stack={null} onSaved={onSaved} />)

        await press(tree, 0) // scan-stack: permission is already granted, so this opens the camera

        const camera = tree.root.findByType(CameraView)
        await act(async () => {
            camera.props.onBarcodeScanned({ data: JSON.stringify(stack) })
            camera.props.onBarcodeScanned({ data: JSON.stringify(stack) })
            await flush()
        })

        expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it("shows the parser's error message for malformed pasted text", async () => {
        const tree = await renderScreen(<ConfigScreen stack={null} onSaved={jest.fn()} />)

        await changeText(tree, 0, "not json")
        await press(tree, 1)

        expect(allText(tree)).toContain("that isn't valid JSON")
    })
})
