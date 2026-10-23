import { useState } from "react"
import type { JSX } from "react"
import { Pressable, Text, View } from "react-native"
import { useTheme } from "../tokens"
import Icon from "./Icon"

export interface KeyValueProps {
    label: string
    value: string
    mono?: boolean
    /** Set false for a value whose full text is the point and must never hide behind a tap - a consent callback. */
    truncate?: boolean
    /** One plain sentence saying what the row means, behind an info icon so the screen stays terse. */
    hint?: string
}

const HEAD = 6
const TAIL = 4

/** `0x1234…abcd`-style truncation; only shortens a value long enough for the ellipsis to earn its place. */
export function middleTruncate(value: string): string {
    if (value.length <= HEAD + TAIL + 1) {
        return value
    }
    return `${value.slice(0, HEAD)}…${value.slice(-TAIL)}`
}

/** A label/value row. Long values truncate by default; tapping reveals the full, selectable text. */
export default function KeyValue({ label, value, mono = false, truncate = true, hint }: KeyValueProps): JSX.Element {
    const theme = useTheme()
    const [expanded, setExpanded] = useState(false)
    const [hintOpen, setHintOpen] = useState(false)
    const truncated = truncate ? middleTruncate(value) : value
    const canExpand = truncated !== value

    return (
        <View style={{ gap: theme.spacing.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
                <Text style={{ ...theme.type.xs, color: theme.colors.muted, textTransform: "uppercase" }}>{label}</Text>
                {hint ? (
                    <Pressable
                        onPress={() => setHintOpen((open) => !open)}
                        accessibilityRole="button"
                        accessibilityLabel={`About ${label}`}
                        accessibilityState={{ expanded: hintOpen }}
                        hitSlop={8}
                    >
                        <Icon name="info" size={14} color={theme.colors.muted} />
                    </Pressable>
                ) : null}
            </View>
            <Pressable
                disabled={!canExpand}
                onPress={() => setExpanded((current) => !current)}
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={canExpand ? 8 : undefined}
                android_ripple={canExpand ? { color: `${theme.colors.ink}14` } : undefined}
            >
                <Text
                    selectable
                    style={{
                        ...theme.type.sm,
                        color: theme.colors.ink,
                        fontFamily: mono ? theme.fonts.mono : undefined
                    }}
                >
                    {expanded ? value : truncated}
                </Text>
            </Pressable>
            {hintOpen ? <Text style={{ ...theme.type.xs, color: theme.colors.muted }}>{hint}</Text> : null}
        </View>
    )
}
