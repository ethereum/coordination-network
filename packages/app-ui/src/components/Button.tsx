import type { JSX } from "react"
import { ActivityIndicator, Pressable, Text } from "react-native"
import { useTheme } from "../tokens"

export type ButtonVariant = "primary" | "secondary" | "danger"

export interface ButtonProps {
    label: string
    onPress: () => void
    variant?: ButtonVariant
    loading?: boolean
    disabled?: boolean
    testID?: string
}

/** The one tappable action control; every screen's buttons go through this. */
export default function Button({
    label,
    onPress,
    variant = "primary",
    loading = false,
    disabled = false,
    testID
}: ButtonProps): JSX.Element {
    const theme = useTheme()
    const isDisabled = disabled || loading
    const variantBackground: Record<ButtonVariant, string> = {
        primary: theme.colors.accent,
        secondary: theme.colors.surface,
        danger: theme.colors.danger
    }
    const variantText: Record<ButtonVariant, string> = {
        primary: theme.colors.onAccent,
        secondary: theme.colors.ink,
        danger: theme.colors.surface
    }

    return (
        <Pressable
            testID={testID}
            disabled={isDisabled}
            accessibilityRole="button"
            // The label stays the accessibility name even while loading swaps it for a spinner -
            // otherwise a loading button announces nothing.
            accessibilityLabel={label}
            accessibilityState={{ disabled: isDisabled, busy: loading }}
            // Pressable's own `disabled` gates a real touch, not a direct call to `onPress` -
            // guarded here too so a loading or disabled button can't fire twice.
            onPress={() => !isDisabled && onPress()}
            android_ripple={isDisabled ? undefined : { color: `${variantText[variant]}33` }}
            style={{
                minHeight: 48,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: theme.radii.sm,
                borderCurve: "continuous",
                borderWidth: variant === "secondary" ? 1 : 0,
                borderColor: theme.colors.line,
                backgroundColor: variantBackground[variant],
                opacity: isDisabled ? 0.6 : 1,
                paddingHorizontal: theme.spacing.lg
            }}
        >
            {loading ? (
                <ActivityIndicator color={variantText[variant]} />
            ) : (
                <Text
                    style={{
                        ...theme.type.md,
                        fontWeight: "600",
                        fontFamily: theme.face("600"),
                        color: variantText[variant]
                    }}
                >
                    {label}
                </Text>
            )}
        </Pressable>
    )
}
