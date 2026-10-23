import type { JSX } from "react"
import { Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../tokens"
import Icon from "./Icon"
import type { IconName } from "./Icon"

export interface TabBarItem<K extends string = string> {
    key: K
    label: string
    icon: IconName
}

export interface TabBarProps<K extends string> {
    items: TabBarItem<K>[]
    activeKey: K
    onSelect: (key: K) => void
}

/** The bottom tab bar every app screen sits above. Needs a `SafeAreaProvider` ancestor, for
 *  `useSafeAreaInsets`. */
export default function TabBar<K extends string>({ items, activeKey, onSelect }: TabBarProps<K>): JSX.Element {
    const theme = useTheme()
    const insets = useSafeAreaInsets()

    return (
        <View
            accessibilityRole="tablist"
            style={{
                flexDirection: "row",
                minHeight: 56,
                paddingBottom: insets.bottom,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
                backgroundColor: theme.colors.surface
            }}
        >
            {items.map((item) => {
                const active = item.key === activeKey
                const color = active ? theme.colors.accentInk : theme.colors.muted
                return (
                    <Pressable
                        key={item.key}
                        testID={`tab-${item.key}`}
                        onPress={() => onSelect(item.key)}
                        accessibilityRole="tab"
                        accessibilityLabel={item.label}
                        accessibilityState={{ selected: active }}
                        android_ripple={{ color: `${theme.colors.ink}14` }}
                        style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing.xs }}
                    >
                        <Icon name={item.icon} size={20} color={color} />
                        <Text
                            style={{
                                ...theme.type.xs,
                                fontWeight: active ? "700" : "500",
                                fontFamily: theme.face(active ? "700" : "500"),
                                color
                            }}
                        >
                            {item.label}
                        </Text>
                    </Pressable>
                )
            })}
        </View>
    )
}
