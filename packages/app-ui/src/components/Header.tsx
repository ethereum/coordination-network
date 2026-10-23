import type { JSX, ReactNode } from "react"
import { Text, View } from "react-native"
import { useTheme } from "../tokens"

export interface HeaderProps {
    eyebrow?: string
    title: string
    subtitle?: string
    right?: ReactNode
}

/** A screen's title block, with an optional eyebrow line, subtitle and a right-aligned action. */
export default function Header({ eyebrow, title, subtitle, right }: HeaderProps): JSX.Element {
    const theme = useTheme()

    return (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: theme.spacing.md }}>
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
                {eyebrow ? (
                    <Text
                        style={{
                            ...theme.type.xs,
                            color: theme.colors.muted,
                            textTransform: "uppercase",
                            letterSpacing: 1
                        }}
                    >
                        {eyebrow}
                    </Text>
                ) : null}
                <Text
                    style={{
                        ...theme.type.xl,
                        fontWeight: "700",
                        fontFamily: theme.face("700"),
                        color: theme.colors.ink
                    }}
                >
                    {title}
                </Text>
                {subtitle ? <Text style={{ ...theme.type.sm, color: theme.colors.muted }}>{subtitle}</Text> : null}
            </View>
            {right}
        </View>
    )
}
