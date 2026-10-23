import type { JSX, ReactNode } from "react"
import { StyleSheet, Text, View } from "react-native"
import Animated from "react-native-reanimated"
import { useTheme } from "../tokens"
import type { Theme } from "../tokens"
import { entrances, useEntering } from "../motion"
import Icon from "./Icon"
import type { IconName } from "./Icon"

export type OutcomeTone = "success" | "danger" | "neutral"

export interface OutcomeProps {
    tone: OutcomeTone
    icon: IconName
    title: string
    /** Up to three short lines; anything longer belongs behind a `Disclosure`. */
    lines?: string[]
    children?: ReactNode
    testID?: string
    /** False skips the mount entrance - for an Outcome nested inside a body that already animates in. */
    entering?: boolean
}

function toneColor(theme: Theme, tone: OutcomeTone): string {
    switch (tone) {
        case "success":
            return theme.colors.success
        case "danger":
            return theme.colors.danger
        case "neutral":
            return theme.colors.accentInk
    }
}

/**
 * How a flow ended, in one icon, one title and a few short lines. The icon is a stamp: a ring in
 * the tone's colour, a couple of degrees off square, because a verdict is the one thing on any of
 * these screens that should look like it was pressed onto the page rather than laid out on it.
 * It is also the only place in either app that carries a flourish like this - a verdict is the
 * moment the whole flow exists for, and spending the boldness anywhere else would spend it twice.
 */
export default function Outcome({
    tone,
    icon,
    title,
    lines,
    children,
    testID,
    entering = true
}: OutcomeProps): JSX.Element {
    const theme = useTheme()
    const color = toneColor(theme, tone)
    const entrance = useEntering(entrances.stamp)

    return (
        <Animated.View
            entering={entering ? entrance : undefined}
            testID={testID}
            style={{ alignItems: "center", gap: theme.spacing.md, paddingVertical: theme.spacing.lg }}
        >
            <View
                style={{
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    borderWidth: 2,
                    borderColor: color,
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    transform: [{ rotate: "-2deg" }]
                }}
            >
                <View
                    pointerEvents="none"
                    style={{ ...StyleSheet.absoluteFillObject, backgroundColor: color, opacity: 0.1 }}
                />
                <Icon name={icon} size={30} color={color} />
            </View>
            <Text
                style={{
                    ...theme.type.xl,
                    fontWeight: "700",
                    fontFamily: theme.face("700"),
                    color: theme.colors.ink,
                    textAlign: "center"
                }}
            >
                {title}
            </Text>
            {lines?.map((line) => (
                <Text key={line} style={{ ...theme.type.sm, color: theme.colors.muted, textAlign: "center" }}>
                    {line}
                </Text>
            ))}
            {children}
        </Animated.View>
    )
}
