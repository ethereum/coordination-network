let mockGranted = true
const mockRequestPermission = jest.fn(async () => ({ granted: false }))
beforeEach(() => {
    mockGranted = true
    mockRequestPermission.mockClear()
})
jest.mock("expo-camera", () => ({
    CameraView: () => null,
    useCameraPermissions: () => [{ granted: mockGranted }, mockRequestPermission]
}))
import { CameraView } from "expo-camera"
import { View, StyleSheet } from "react-native"
import * as safeArea from "react-native-safe-area-context"
import { act } from "react-test-renderer"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import ScanProof from "../ScanProof"

it("scans a presentation once even when the camera reports duplicate frames", async () => {
    const onPresent = jest.fn(async () => ({ verificationId: "result" }))
    const tree = await renderScreen(<ScanProof onPresent={onPresent} isBusy={() => false} />)
    await act(async () => {
        tree.root.findByProps({ testID: "scan-presentation" }).props.onPress()
    })
    const camera = tree.root.findByType(CameraView)
    await act(async () => {
        camera.props.onBarcodeScanned({ data: "challenge-qr" })
        camera.props.onBarcodeScanned({ data: "challenge-qr" })
    })
    expect(onPresent).toHaveBeenCalledTimes(1)
    expect(allText(tree)).toContain("Proof submitted. Check the result on the verifier’s phone.")
})
it("displays invalid QR / offline errors without claiming verification succeeded", async () => {
    const tree = await renderScreen(
        <ScanProof
            onPresent={async () => {
                throw new Error("Invalid presentation QR")
            }}
            isBusy={() => false}
        />
    )
    await act(async () => {
        tree.root.findByProps({ testID: "scan-presentation" }).props.onPress()
    })
    await act(async () => {
        tree.root.findByType(CameraView).props.onBarcodeScanned({ data: "bad" })
    })
    expect(allText(tree)).toContain("Invalid presentation QR")
    expect(allText(tree)).not.toContain("Eligible")
})
it("cancelling scanning never presents a credential", async () => {
    const onPresent = jest.fn()
    const tree = await renderScreen(<ScanProof onPresent={onPresent} isBusy={() => false} />)
    await act(async () => {
        tree.root.findByProps({ testID: "scan-presentation" }).props.onPress()
    })
    const scanned = tree.root.findByType(CameraView).props.onBarcodeScanned
    await act(async () => {
        tree.root.findByProps({ testID: "cancel-proof-scan" }).props.onPress()
    })
    await act(async () => {
        scanned({ data: "late-frame" })
    })
    expect(tree.root.findAllByType(CameraView)).toHaveLength(0)
    expect(onPresent).not.toHaveBeenCalled()
})
it("does not open scanning over another consent or proof request", async () => {
    const tree = await renderScreen(<ScanProof onPresent={jest.fn()} isBusy={() => true} />)
    await act(async () => {
        tree.root.findByProps({ testID: "scan-presentation" }).props.onPress()
    })
    expect(tree.root.findAllByType(CameraView)).toHaveLength(0)
    expect(allText(tree)).toContain("Another request is in progress. Finish it first.")
})

it("explains denied camera permission without opening the scanner", async () => {
    mockGranted = false
    const tree = await renderScreen(<ScanProof onPresent={jest.fn()} isBusy={() => false} />)
    await act(async () => {
        tree.root.findByProps({ testID: "scan-presentation" }).props.onPress()
    })
    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
    expect(tree.root.findAllByType(CameraView)).toHaveLength(0)
    expect(allText(tree)).toContain("Camera permission is required to scan a challenge.")
})

it("keeps the scanner cancel button above the bottom gesture area", async () => {
    const insets = jest.spyOn(safeArea, "useSafeAreaInsets").mockReturnValue({ top: 0, bottom: 34, left: 0, right: 0 })
    const tree = await renderScreen(<ScanProof onPresent={jest.fn()} isBusy={() => false} />)
    try {
        await act(async () => {
            tree.root.findByProps({ testID: "scan-presentation" }).props.onPress()
        })
        const styles = tree.root.findAllByType(View).map((node) => StyleSheet.flatten(node.props.style))
        expect(styles.some((style) => style?.paddingBottom >= 34)).toBe(true)
    } finally {
        await act(async () => tree.unmount())
        insets.mockRestore()
    }
})
