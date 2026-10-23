import type { JSX } from "react"
import { Feather } from "@expo/vector-icons"
import { useTheme } from "../tokens"

export type IconName =
    | "credit-card"
    | "user"
    | "settings"
    | "sliders"
    | "shield"
    | "key"
    | "file-text"
    | "activity"
    | "search"
    | "slash"
    | "check"
    | "check-circle"
    | "x"
    | "x-circle"
    | "circle"
    | "user-plus"
    | "zap"
    | "eye-off"
    | "lock"
    | "arrow-right"
    | "link"
    | "external-link"
    | "camera"
    | "info"
    | "alert-triangle"
    | "users"
    | "send"
    | "chevron-down"
    | "chevron-up"

export interface IconProps {
    name: IconName
    size?: number
    color?: string
}

/** A Feather glyph from the shared icon set. */
export default function Icon({ name, size = 20, color }: IconProps): JSX.Element {
    const theme = useTheme()
    return <Feather name={name} size={size} color={color ?? theme.colors.ink} />
}
