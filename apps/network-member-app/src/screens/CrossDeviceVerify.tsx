import type { JSX } from "react"
import { Text, View } from "react-native"
import { Button, Card, Outcome, useTheme } from "@coordination-network/app-ui"
import type { CrossDeviceVerification } from "../use-cross-device-verification"
import { CODE_LINE } from "./verification-messages"
import PresentationQr from "./PresentationQr"

export interface CrossDeviceVerifyProps {
    verification: CrossDeviceVerification
    programme: string
    country: string
    onBack: () => void
}

export default function CrossDeviceVerify({
    verification,
    programme,
    country,
    onBack
}: CrossDeviceVerifyProps): JSX.Element {
    const theme = useTheme()
    const { request, result, terminal, error, starting, cancelling } = verification
    const line = result?.code ? CODE_LINE[result.code] : undefined

    return (
        <View style={{ gap: theme.spacing.md }}>
            <Card title="Check another phone">
                <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>
                    {request?.programme ?? programme} · {request?.country ?? country}
                </Text>
                {!request && !starting ? <Text>Ask the holder to open Scan proof in their wallet.</Text> : null}
                {request && !terminal && !result ? (
                    <>
                        <PresentationQr value={request.qr} />
                        <Text>Scan with the holder’s wallet. Both phones need a connection.</Text>
                        <Text>{error ? "Result checking paused." : "Waiting for the verifier server…"}</Text>
                        <Text>Expires at {new Date(request.expiresAt * 1000).toLocaleTimeString()}</Text>
                    </>
                ) : null}
            </Card>
            {result ? (
                <Outcome
                    testID="cross-device-outcome"
                    tone={result.ok ? "success" : "danger"}
                    icon={result.ok ? "check-circle" : "x-circle"}
                    title={result.ok ? "Eligible" : "Not eligible"}
                    lines={
                        result.ok ? [`Valid ${result.programme} credential · ${result.country}`] : line ? [line] : []
                    }
                />
            ) : null}
            {terminal ? <Text testID="cross-device-terminal">{terminal}</Text> : null}
            {error ? <Text testID="cross-device-error">{error}</Text> : null}
            {!request && !starting ? (
                <Button
                    testID="create-presentation-qr"
                    label="Create challenge QR"
                    onPress={() => void verification.start({ programme, country })}
                />
            ) : null}
            {result || terminal ? (
                <Button
                    testID="new-cross-device-check"
                    label="New check"
                    onPress={() => {
                        void verification.start({ programme, country })
                    }}
                />
            ) : null}
            {starting ? <Text>Creating challenge…</Text> : null}
            {error && request && !terminal && !result ? (
                <Button testID="retry-presentation-status" label="Retry status" onPress={verification.retryStatus} />
            ) : null}
            {request && !terminal && !result ? (
                <Button
                    testID="cancel-presentation"
                    loading={cancelling}
                    label="Cancel check"
                    variant="secondary"
                    onPress={() => void verification.cancel()}
                />
            ) : null}
            <Button testID="close-cross-device" label="Back" variant="secondary" onPress={onBack} />
        </View>
    )
}
