import { useEffect, useRef } from "react"
import { View } from "react-native"
import { CameraView } from "expo-camera"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, useTheme } from "@coordination-network/app-ui"

export default function QrScanner({
    onScan,
    onCancel,
    cancelTestID
}: {
    onScan: (raw: string) => void
    onCancel: () => void
    cancelTestID?: string
}) {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const accepting = useRef(true)
    useEffect(() => {
        accepting.current = true
        return () => {
            accepting.current = false
        }
    }, [])
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
            <CameraView
                style={{ flex: 1 }}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => {
                    if (!accepting.current) return
                    accepting.current = false
                    onScan(data)
                }}
            />
            <View style={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.lg + insets.bottom }}>
                <Button
                    testID={cancelTestID}
                    label="Cancel"
                    variant="secondary"
                    onPress={() => {
                        accepting.current = false
                        onCancel()
                    }}
                />
            </View>
        </View>
    )
}
