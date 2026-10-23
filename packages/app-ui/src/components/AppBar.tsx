import type { JSX } from "react"
import { Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../tokens"

export interface AppBarProps {
    name: string
    /** No top inset - what `Sheet` shows above a modal's body. */
    compact?: boolean
    testID?: string
}

/** The solid accent band every screen opens with, so an audience watching a deep link jump
 *  between apps always knows which one is on screen. Needs a `SafeAreaProvider` ancestor, for
 *  `useSafeAreaInsets`. */
export default function AppBar({ name, compact = false, testID }: AppBarProps): JSX.Element {
    const theme = useTheme()
    const insets = useSafeAreaInsets()

    if (compact) {
        return (
            <View
                testID={testID}
                style={{
                    backgroundColor: theme.colors.accent,
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md
                }}
            >
                <Text
                    style={{
                        ...theme.type.md,
                        fontWeight: "700",
                        fontFamily: theme.face("700"),
                        textTransform: "uppercase",
                        color: theme.colors.onAccent
                    }}
                >
                    {name}
                </Text>
            </View>
        )
    }

    return (
        <View
            testID={testID}
            style={{
                backgroundColor: theme.colors.accent,
                paddingTop: insets.top + theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                paddingBottom: theme.spacing.md
            }}
        >
            <Text
                style={{
                    ...theme.type.lg,
                    fontWeight: "700",
                    fontFamily: theme.face("700"),
                    textTransform: "uppercase",
                    color: theme.colors.onAccent
                }}
            >
                {name}
            </Text>
        </View>
    )
}
