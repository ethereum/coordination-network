import { useEffect, useState } from "react"
import type { JSX } from "react"
import { Text, View } from "react-native"
import { Badge, Button, Card, EmptyState, Header, Screen, useTheme } from "@coordination-network/app-ui"
import { clearActivity, subscribeToActivity } from "../business"
import type { ActivityEntry } from "../business"

function formatTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export default function ActivityScreen(): JSX.Element {
    const theme = useTheme()
    const [entries, setEntries] = useState<ActivityEntry[]>([])

    useEffect(() => subscribeToActivity(setEntries), [])

    return (
        <Screen scroll>
            <Header
                title="Activity"
                right={<Button testID="clear-activity" label="Clear" variant="secondary" onPress={clearActivity} />}
            />
            <View style={{ gap: theme.spacing.lg, marginTop: theme.spacing.lg }}>
                {entries.length === 0 ? (
                    <EmptyState icon="activity" title="Nothing yet" body="Run a flow from another tab." />
                ) : (
                    entries.map((entry) => (
                        <Card key={entry.id}>
                            <View
                                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                            >
                                <Text style={{ ...theme.type.xs, color: theme.colors.muted }}>
                                    {formatTime(entry.at)}
                                </Text>
                                <Badge
                                    label={entry.tone === "error" ? "Error" : "Info"}
                                    tone={entry.tone === "error" ? "danger" : "neutral"}
                                />
                            </View>
                            <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>{entry.message}</Text>
                        </Card>
                    ))
                )}
            </View>
        </Screen>
    )
}
