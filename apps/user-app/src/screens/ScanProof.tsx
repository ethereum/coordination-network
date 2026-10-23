import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { Text } from "react-native"
import { useCameraPermissions } from "expo-camera"
import QrScanner from "../components/QrScanner"
import { Button, Card, Header, Screen, useTheme } from "@coordination-network/app-ui"

export interface ScanProofProps {
    onPresent: (raw: string) => Promise<unknown>
    isBusy: () => boolean
}

export default function ScanProof({ onPresent, isBusy }: ScanProofProps): JSX.Element {
    const theme = useTheme()
    const [permission, requestPermission] = useCameraPermissions()
    const [scanning, setScanning] = useState(false)
    const [working, setWorking] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const mounted = useRef(true)
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
        }
    }, [])

    async function scan() {
        if (isBusy()) {
            setMessage("Another request is in progress. Finish it first.")
            return
        }
        setMessage(null)
        if (!permission?.granted && !(await requestPermission()).granted) {
            setMessage("Camera permission is required to scan a challenge.")
            return
        }
        if (!mounted.current) return
        setScanning(true)
    }

    async function decoded(raw: string) {
        setScanning(false)
        if (isBusy()) {
            setMessage("Another request is in progress. Finish it first.")
            return
        }
        setWorking(true)
        try {
            await onPresent(raw)
            if (mounted.current) setMessage("Proof submitted. Check the result on the verifier’s phone.")
        } catch (error) {
            if (mounted.current)
                setMessage(
                    error instanceof Error
                        ? error.message
                        : "Could not submit the proof. Check your connection and ask for a new QR."
                )
        } finally {
            if (mounted.current) setWorking(false)
        }
    }

    if (scanning)
        return (
            <QrScanner
                onScan={(raw) => void decoded(raw)}
                onCancel={() => setScanning(false)}
                cancelTestID="cancel-proof-scan"
            />
        )
    return (
        <Screen scroll>
            <Header title="Scan proof" />
            <Card title="Prove your approval">
                <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>
                    Scan the challenge QR on the verifier’s phone. You will review what is shared before a proof is
                    sent. Both phones need a connection.
                </Text>
                {message ? <Text testID="proof-scan-message">{message}</Text> : null}
                <Button
                    testID="scan-presentation"
                    label={working ? "Submitting…" : "Scan challenge QR"}
                    loading={working}
                    onPress={() => void scan()}
                />
            </Card>
        </Screen>
    )
}
