jest.mock("expo-camera", () => ({
    CameraView: () => null,
    useCameraPermissions: () => [{ granted: true }, jest.fn()]
}))

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { act } from "react-test-renderer"
import { CameraView } from "expo-camera"
import { allText, changeText, press, renderScreen } from "@coordination-network/app-ui/testing"
import SetupScreen from "../../src/screens/Setup"
import { PAIRING_URL_A, fakePairing, fakeStack, withStackJson } from "../support"

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("SetupScreen", () => {
    const originalFetch = global.fetch

    beforeEach(() => {
        global.fetch = jest.fn(withStackJson()) as never
    })

    afterEach(() => {
        global.fetch = originalFetch
    })

    it("asks to connect, in two words and two buttons", async () => {
        const tree = await renderScreen(<SetupScreen onPaired={jest.fn()} />)

        const text = allText(tree)
        expect(text).toContain("Connect")
        expect(text).toContain("Scan QR")
        expect(text).toContain("Save")
    })

    it("accepts a pasted pairing link", async () => {
        const onPaired = jest.fn()
        const tree = await renderScreen(<SetupScreen onPaired={onPaired} />)

        await changeText(tree, 0, PAIRING_URL_A)
        await press(tree, 1) // scan-stack (0) precedes save-pasted (1) in render order

        expect(onPaired).toHaveBeenCalledWith(fakePairing())
    })

    it("sends a pasted descriptor, or anything else that isn't a pairing link, to the pairing QR", async () => {
        const onPaired = jest.fn()
        const tree = await renderScreen(<SetupScreen onPaired={onPaired} />)

        await changeText(tree, 0, JSON.stringify(fakeStack()))
        await press(tree, 1)

        expect(allText(tree)).toContain(
            "that's the stack's public QR - scan this org's pairing QR from the terminal running yarn stack"
        )
        expect(onPaired).not.toHaveBeenCalled()
    })

    it("refuses a stack without this member, and doesn't call onPaired", async () => {
        const onPaired = jest.fn()
        global.fetch = jest.fn(withStackJson(undefined, { ...fakeStack(), members: [] })) as never
        const tree = await renderScreen(<SetupScreen onPaired={onPaired} />)

        await changeText(tree, 0, PAIRING_URL_A)
        await press(tree, 1)

        expect(allText(tree)).toContain("this stack has no member for member-a")
        expect(onPaired).not.toHaveBeenCalled()
    })

    it("accepts a scanned pairing link once when two frames decode before scanning=false commits", async () => {
        const onPaired = jest.fn()
        const tree = await renderScreen(<SetupScreen onPaired={onPaired} />)

        await press(tree, 0) // scan-stack: permission is already granted, so this opens the camera

        const camera = tree.root.findByType(CameraView)
        await act(async () => {
            camera.props.onBarcodeScanned({ data: PAIRING_URL_A })
            camera.props.onBarcodeScanned({ data: PAIRING_URL_A })
            await flush()
        })

        expect(onPaired).toHaveBeenCalledTimes(1)
    })
})
