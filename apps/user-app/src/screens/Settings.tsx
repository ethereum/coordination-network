import { useState } from "react"
import type { JSX } from "react"
import { Alert, View } from "react-native"
import { Button, Header, Screen, useTheme } from "@coordination-network/app-ui"
import type { UserAppService } from "@coordination-network/user-app-core"

export interface SettingsScreenProps {
    service: UserAppService
    eraseDeviceStore: () => Promise<void>
    eraseDeviceKey: () => Promise<number>
    /** Runs after a successful erase, so the caller can rebuild the ports its stale device key held. */
    onErased: () => Promise<void>
}

/**
 * Erases everything: the held identity, credentials and revocation secrets (`service.erase()`),
 * the store's own secret index (`eraseDeviceStore`), and the hardware device keys themselves
 * (`eraseDeviceKey`). Irreversible, so it's confirmed once before running.
 */
export default function SettingsScreen({
    service,
    eraseDeviceStore,
    eraseDeviceKey,
    onErased
}: SettingsScreenProps): JSX.Element {
    const theme = useTheme()
    const [erasing, setErasing] = useState(false)

    async function runErase(): Promise<void> {
        setErasing(true)
        try {
            await service.erase()
            await eraseDeviceStore()
            await eraseDeviceKey()
            await onErased()
        } finally {
            setErasing(false)
        }
    }

    function confirmErase(): void {
        Alert.alert("Erase everything?", "Deletes your identity, credentials and keys.", [
            { text: "Cancel", style: "cancel" },
            { text: "Erase", style: "destructive", onPress: () => void runErase() }
        ])
    }

    return (
        <Screen>
            <View style={{ gap: theme.spacing.lg }}>
                <Header title="Settings" />
                <Button
                    testID="erase-everything"
                    label="Erase everything"
                    variant="danger"
                    loading={erasing}
                    onPress={confirmErase}
                />
            </View>
        </Screen>
    )
}
