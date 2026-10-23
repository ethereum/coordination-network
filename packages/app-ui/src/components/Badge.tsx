import type { JSX } from "react"
import { StyleSheet, Text, View } from "react-native"
import { useTheme } from "../tokens"

export type BadgeTone = "neutral" | "accent" | "warning" | "danger" | "success"

export interface BadgeProps {
    label: string
    tone?: BadgeTone
}

/** A short status pill, coloured by tone. */
export default function Badge({ label, tone = "neutral" }: BadgeProps): JSX.Element {
    const theme = useTheme()
    const toneColor: Record<BadgeTone, string> = {
        neutral: theme.colors.muted,
        accent: theme.colors.accentInk,
        warning: theme.colors.warning,
        danger: theme.colors.danger,
        success: theme.colors.success
    }
    const color = toneColor[tone]

    return (
        <View
            style={{
                alignSelf: "flex-start",
                borderRadius: theme.radii.sm,
                paddingHorizontal: theme.spacing.sm,
                paddingVertical: theme.spacing.xs,
                overflow: "hidden"
            }}
        >
            {/* A translucent layer of the tone colour rather than an alpha suffix on its string, so
                any colour format a member passes as its accent tints the same way. */}
            <View
                pointerEvents="none"
                style={{ ...StyleSheet.absoluteFillObject, backgroundColor: color, opacity: 0.12 }}
            />
            <Text style={{ ...theme.type.xs, fontWeight: "600", fontFamily: theme.face("600"), color }}>{label}</Text>
        </View>
    )
}
