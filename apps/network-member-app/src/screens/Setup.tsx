import { useRef, useState } from "react"
import type { JSX } from "react"
import { Text, TextInput, View } from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import type { BarcodeScanningResult } from "expo-camera"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Button, Header, Screen, useTheme } from "@coordination-network/app-ui"
import { business } from "../business"
import { buildMemberConfig, memberId, resolvePairing } from "../config"
import type { Pairing } from "../config"

export interface SetupScreenProps {
    onPaired: (pairing: Pairing) => void
    /** Shown on mount - e.g. App clearing a stored stack.json it could no longer parse. */
    initialError?: string | null
}

/** Shown until this app is paired, by scanning or pasting this org's pairing link from `yarn stack`. */
export default function SetupScreen({ onPaired, initialError = null }: SetupScreenProps): JSX.Element {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const [permission, requestPermission] = useCameraPermissions()
    const [scanning, setScanning] = useState(false)
    const scanningRef = useRef(false)
    const [pasted, setPasted] = useState("")
    const [error, setError] = useState<string | null>(initialError)
    const [saving, setSaving] = useState(false)

    async function accept(raw: string): Promise<void> {
        setSaving(true)
        try {
            const pairing = await resolvePairing(raw, memberId)
            // Confirms this member has a place in the stack before it's stored - a descriptor
            // that doesn't would otherwise throw on every future launch, past Setup, with no
            // error boundary to catch it.
            buildMemberConfig(pairing, memberId, business.branding.displayName)
            setError(null)
            onPaired(pairing)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSaving(false)
        }
    }

    // CameraView fires per decoded frame, not once per code, so a scan must be closed
    // synchronously before the first `await`. `scanning` itself isn't enough: two frames can each
    // read it before React commits `setScanning(false)` from the first, so the guard is a ref
    // instead, set synchronously in the same tick a frame is accepted - see `apps/user-app`'s
    // Config screen for the same rule.
    function handleBarcodeScanned(result: BarcodeScanningResult): void {
        if (!scanningRef.current) return
        scanningRef.current = false
        setScanning(false)
        void accept(result.data)
    }

    async function startScanning(): Promise<void> {
        if (!permission?.granted) {
            const result = await requestPermission()
            if (!result.granted) {
                setError("camera permission denied - paste this org's pairing link below instead")
                return
            }
        }
        setError(null)
        scanningRef.current = true
        setScanning(true)
    }

    if (scanning) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
                <CameraView
                    style={{ flex: 1 }}
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={handleBarcodeScanned}
                />
                <View style={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.lg + insets.bottom }}>
                    <Button
                        label="Cancel"
                        variant="secondary"
                        onPress={() => {
                            scanningRef.current = false
                            setScanning(false)
                        }}
                    />
                </View>
            </View>
        )
    }

    return (
        <Screen scroll>
            <Header title="Connect" />
            <View style={{ gap: theme.spacing.lg, marginTop: theme.spacing.lg }}>
                {error !== null ? <Text style={{ ...theme.type.sm, color: theme.colors.danger }}>{error}</Text> : null}

                <Button testID="scan-stack" label="Scan QR" variant="secondary" onPress={() => void startScanning()} />

                <TextInput
                    testID="paste-stack"
                    style={{
                        ...theme.type.xs,
                        fontFamily: theme.fonts.mono,
                        color: theme.colors.ink,
                        backgroundColor: theme.colors.surface,
                        borderColor: theme.colors.line,
                        borderWidth: 1,
                        borderRadius: theme.radii.md,
                        padding: theme.spacing.md,
                        minHeight: 100,
                        textAlignVertical: "top"
                    }}
                    multiline
                    value={pasted}
                    onChangeText={setPasted}
                    placeholder="http://…/stack.json#org=…&token=…"
                    placeholderTextColor={theme.colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
                <Button
                    testID="save-pasted"
                    label={saving ? "Saving…" : "Save"}
                    loading={saving}
                    disabled={pasted.trim().length === 0}
                    onPress={() => void accept(pasted)}
                />
            </View>
        </Screen>
    )
}
