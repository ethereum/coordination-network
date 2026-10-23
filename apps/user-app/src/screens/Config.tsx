import { useState } from "react"
import type { JSX } from "react"
import { Text, TextInput, View } from "react-native"
import { useCameraPermissions } from "expo-camera"
import QrScanner from "../components/QrScanner"
import { Button, Card, EmptyState, FieldGroup, Header, KeyValue, Screen, useTheme } from "@coordination-network/app-ui"
import { resolveStackDescriptor, writeStackConfig, type MemberRole, type StackDescriptor } from "../config"

const ROLE_LABEL: Record<MemberRole, string> = {
    founder: "founding org",
    candidate: "candidate"
}

export interface ConfigScreenProps {
    stack: StackDescriptor | null
    /** Runs after a scanned or pasted stack.json is resolved and persisted. */
    onSaved: (stack: StackDescriptor) => void
}

/**
 * Loads `stack.json` (`yarn stack`'s dashboard) by camera or paste, either its URL — what the QR
 * now encodes, since the widened descriptor no longer fits one — or the JSON itself. It's the
 * only place this app learns about network members at all — there is no discovery mechanism.
 */
export default function ConfigScreen({ stack, onSaved }: ConfigScreenProps): JSX.Element {
    const theme = useTheme()
    const [permission, requestPermission] = useCameraPermissions()
    const [scanning, setScanning] = useState(false)
    const [pasted, setPasted] = useState("")
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    async function save(raw: string): Promise<void> {
        setSaving(true)
        try {
            const descriptor = await resolveStackDescriptor(raw)
            await writeStackConfig(descriptor)
            setError(null)
            onSaved(descriptor)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSaving(false)
        }
    }

    /** QrScanner accepts one frame; close it before starting the asynchronous save. */
    function handleBarcodeScanned(raw: string): void {
        setScanning(false)
        void save(raw)
    }

    async function handleScanPress(): Promise<void> {
        if (!permission?.granted) {
            const result = await requestPermission()
            if (!result.granted) return
        }
        setScanning(true)
    }

    if (scanning) {
        return <QrScanner onScan={handleBarcodeScanned} onCancel={() => setScanning(false)} />
    }

    return (
        <Screen scroll>
            <View style={{ gap: theme.spacing.lg }}>
                <Header title="Config" />
                {stack !== null ? (
                    <Card title="Current stack">
                        <FieldGroup>
                            <KeyValue label="RPC" value={stack.rpcUrl} />
                            <KeyValue label="Chain ID" value={String(stack.chainId)} />
                            {stack.members.map((member) => (
                                <KeyValue
                                    key={member.networkId}
                                    label={`${member.name} (${ROLE_LABEL[member.role]})`}
                                    value={member.serverUrl}
                                />
                            ))}
                            <KeyValue label="Dashboard" value={stack.dashboardUrl} />
                        </FieldGroup>
                    </Card>
                ) : (
                    <EmptyState
                        icon="sliders"
                        title="No stack configured yet"
                        body="Scan the dashboard's QR code, or paste its URL or stack.json below."
                    />
                )}

                {error !== null ? <Text style={{ ...theme.type.sm, color: theme.colors.danger }}>{error}</Text> : null}

                <Button
                    testID="scan-stack"
                    label="Scan QR code"
                    variant="secondary"
                    onPress={() => void handleScanPress()}
                />

                <Text style={{ ...theme.type.sm, color: theme.colors.muted }}>
                    Or paste the dashboard's stack.json URL or its contents:
                </Text>
                <TextInput
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
                    placeholder="https://… or { ... }"
                    placeholderTextColor={theme.colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
                <Button
                    testID="save-pasted"
                    label={saving ? "Saving…" : "Save"}
                    loading={saving}
                    onPress={() => void save(pasted)}
                />
            </View>
        </Screen>
    )
}
