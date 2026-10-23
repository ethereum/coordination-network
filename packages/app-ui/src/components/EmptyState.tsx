import type { JSX, ReactNode } from "react"
import { Text, View } from "react-native"
import { useTheme } from "../tokens"
import Icon from "./Icon"
import type { IconName } from "./Icon"

export interface EmptyStateProps {
    title: string
    body?: string
    icon?: IconName
    action?: ReactNode
}

/** Stands in for a list or screen with nothing to show yet. */
export default function EmptyState({ title, body, icon, action }: EmptyStateProps): JSX.Element {
    const theme = useTheme()

    return (
        <View style={{ alignItems: "center", gap: theme.spacing.sm, padding: theme.spacing.xl }}>
            {icon ? <Icon name={icon} size={28} color={theme.colors.muted} /> : null}
            <Text
                style={{
                    ...theme.type.md,
                    fontWeight: "600",
                    fontFamily: theme.face("600"),
                    color: theme.colors.ink,
                    textAlign: "center"
                }}
            >
                {title}
            </Text>
            {body ? (
                <Text style={{ ...theme.type.sm, color: theme.colors.muted, textAlign: "center" }}>{body}</Text>
            ) : null}
            {action}
        </View>
    )
}
