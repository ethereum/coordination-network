import { Children } from "react"
import type { JSX, ReactNode } from "react"
import { View } from "react-native"
import { useTheme } from "../tokens"

export interface FieldGroupProps {
    children: ReactNode
}

/**
 * Label/value rows divided by hairlines instead of floating in gaps. A credential, an identity and
 * a verification are all records of something, and a ruled row is how a record reads: the divider
 * says where one field ends, so the labels do not have to carry that job alone.
 *
 * Takes `KeyValue` children (any node works) and rules between them, never above the first or
 * below the last - a rule at either end would draw a box the panel already has.
 */
export default function FieldGroup({ children }: FieldGroupProps): JSX.Element {
    const theme = useTheme()
    const rows = Children.toArray(children).filter(Boolean)

    return (
        <View>
            {rows.map((row, index) => (
                <View
                    // Index: these rows are a fixed list per render, and a KeyValue carries no id
                    // of its own to key on.
                    key={index}
                    style={{
                        paddingTop: index === 0 ? 0 : theme.spacing.md,
                        paddingBottom: index === rows.length - 1 ? 0 : theme.spacing.md,
                        borderBottomWidth: index === rows.length - 1 ? 0 : 1,
                        borderBottomColor: theme.colors.rule
                    }}
                >
                    {row}
                </View>
            ))}
        </View>
    )
}
