import { useState } from "react"
import type { JSX, ReactNode } from "react"
import { Pressable, Text, View } from "react-native"
import Animated from "react-native-reanimated"
import { entrances, useEntering } from "../motion"
import { useTheme } from "../tokens"
import Icon from "./Icon"

export interface DisclosureProps {
    label?: string
    children: ReactNode
    testID?: string
}

/** Hides technical values (hashes, chain ids, addresses) behind a tap instead of leading the
 *  screen with them. Follows `StepList`'s per-step details toggle. */
export default function Disclosure({ label = "Technical details", children, testID }: DisclosureProps): JSX.Element {
    const theme = useTheme()
    const [open, setOpen] = useState(false)
    const entering = useEntering(entrances.body)

    return (
        <View style={{ gap: theme.spacing.xs }}>
            <Pressable
                testID={testID}
                onPress={() => setOpen((current) => !current)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                hitSlop={8}
                android_ripple={{ color: `${theme.colors.ink}14` }}
                style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}
            >
                <Text
                    style={{
                        ...theme.type.xs,
                        color: theme.colors.accentInk,
                        fontWeight: "600",
                        fontFamily: theme.face("600")
                    }}
                >
                    {label}
                </Text>
                <Icon name={open ? "chevron-up" : "chevron-down"} size={14} color={theme.colors.accentInk} />
            </Pressable>
            {open ? <Animated.View entering={entering}>{children}</Animated.View> : null}
        </View>
    )
}
