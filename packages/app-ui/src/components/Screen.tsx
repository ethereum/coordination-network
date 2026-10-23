import type { JSX, ReactElement, ReactNode } from "react"
import { ScrollView, View } from "react-native"
import type { RefreshControlProps } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../tokens"

export interface ScreenProps {
    scroll?: boolean
    /** A `RefreshControl` for a screen whose content can be re-read on demand; `scroll` only. */
    refreshControl?: ReactElement<RefreshControlProps>
    children: ReactNode
}

/** The canvas every screen sits on. Leaves the top inset to `AppBar`, which every screen renders
 *  above this; the padding above the content is this component's, because the band's own is all
 *  that separated it from a screen's title. Needs a `SafeAreaProvider` ancestor, for
 *  `useSafeAreaInsets`. */
export default function Screen({ scroll = false, refreshControl, children }: ScreenProps): JSX.Element {
    const theme = useTheme()
    const insets = useSafeAreaInsets()
    const container = {
        flex: 1,
        backgroundColor: theme.colors.canvas,
        paddingLeft: insets.left,
        paddingRight: insets.right
    }
    const content = {
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.xl,
        paddingBottom: theme.spacing.xl + theme.spacing.lg
    }

    if (scroll) {
        return (
            <View style={container}>
                <ScrollView contentContainerStyle={content} refreshControl={refreshControl}>
                    {children}
                </ScrollView>
            </View>
        )
    }

    return (
        <View style={container}>
            <View style={content}>{children}</View>
        </View>
    )
}
