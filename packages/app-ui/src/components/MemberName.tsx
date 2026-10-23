import type { JSX } from "react"
import { Text } from "react-native"
import { useTheme } from "../tokens"
import type { Brand } from "../tokens"

export interface MemberNameProps {
    name: string
    /** The member's own brand, not the host app's - a wallet sentence names a member in the member's colour. */
    brand: Brand
    size?: "md" | "lg" | "xl"
}

/** A network member's name in its own colour. A `Text`, so a sentence can nest it mid-line. */
export default function MemberName({ name, brand, size = "md" }: MemberNameProps): JSX.Element {
    const theme = useTheme()

    return (
        <Text style={{ ...theme.type[size], fontWeight: "700", fontFamily: theme.face("700"), color: brand.accentInk }}>
            {name}
        </Text>
    )
}
