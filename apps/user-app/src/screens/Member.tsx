import type { JSX } from "react"
import { Text } from "react-native"
import { MemberName, useTheme } from "@coordination-network/app-ui"
import type { ResolvedMember } from "../members"

export interface MemberProps {
    /** The stack member the caller is, or null when nothing in the stack vouches for its name. */
    member: ResolvedMember | null
    /** The name the caller gave itself, shown only when the stack does not vouch for it. */
    callerName: string
}

/**
 * A member named mid-sentence: in its own ink when the loaded stack vouches for the caller, in plain
 * ink when it does not. A `Text`, so a sentence wraps around it rather than breaking at it.
 */
export default function Member({ member, callerName }: MemberProps): JSX.Element {
    const theme = useTheme()

    return member === null ? (
        <Text style={{ ...theme.type.md, fontWeight: "700", fontFamily: theme.face("700"), color: theme.colors.ink }}>
            {callerName}
        </Text>
    ) : (
        <MemberName name={member.name} brand={member.brand} />
    )
}
