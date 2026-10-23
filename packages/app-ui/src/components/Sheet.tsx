import type { JSX, ReactNode } from "react"
import { Modal, Pressable, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../tokens"
import AppBar from "./AppBar"

export interface SheetProps {
    visible: boolean
    onRequestClose?: () => void
    /** The app's name. When set, a compact `AppBar` caps the sheet so it stays identifiable while
     *  the modal covers the screen. */
    brand?: string
    children: ReactNode
}

/** A bottom sheet over a dimmed backdrop, built on core `Modal`; hosts the consent gate. Needs a
 *  `SafeAreaProvider` ancestor, for `useSafeAreaInsets`. */
export default function Sheet({ visible, onRequestClose, brand, children }: SheetProps): JSX.Element {
    const theme = useTheme()
    const insets = useSafeAreaInsets()

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose}>
            <Pressable
                // Decorative dismiss target, not a labelled control - Deny is the accessible way out.
                accessible={false}
                style={{ flex: 1, backgroundColor: `${theme.colors.ink}80`, justifyContent: "flex-end" }}
                onPress={onRequestClose}
            >
                <Pressable
                    accessible={false}
                    style={{
                        backgroundColor: theme.colors.surface,
                        borderTopLeftRadius: theme.radii.lg,
                        borderTopRightRadius: theme.radii.lg,
                        borderCurve: "continuous",
                        // The one elevation in either app: this panel is over a screen the person
                        // was just reading, and the edge has to say so.
                        boxShadow: `0 -2px 16px ${theme.colors.ink}1f`,
                        overflow: "hidden"
                    }}
                >
                    {brand ? <AppBar compact name={brand} /> : null}
                    <View
                        style={{
                            padding: theme.spacing.lg,
                            paddingBottom: theme.spacing.lg + insets.bottom,
                            gap: theme.spacing.md
                        }}
                    >
                        {children}
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    )
}
