import type { JSX } from "react"
import { Text, View } from "react-native"
import Animated from "react-native-reanimated"
import { entrances, Icon, StepList, useEntering, useTheme } from "@coordination-network/app-ui"
import type { IconName } from "@coordination-network/app-ui"
import type { LinkOp } from "@coordination-network/user-app-link"
import { stepsFor } from "./steps"

const OP_LABEL: Record<LinkOp, string> = {
    "registration.sign": "Sharing your identity",
    "credential.issue": "Storing a credential",
    "presentation.create": "Proving"
}

const OP_ICON: Record<LinkOp, IconName> = {
    "registration.sign": "key",
    "credential.issue": "credit-card",
    "presentation.create": "shield"
}

export interface WorkingProps {
    op: LinkOp
    /** The handler's last reported step, or null until the first one arrives. */
    step: string | null
}

/**
 * The working state's body, hosted by App's single `Sheet` (see App.tsx) from Approve until
 * `onWorking(null)` arrives (see link.ts). The step list is the only thing that moves: no buttons
 * — App omits `onRequestClose` for this phase too, since closing early wouldn't stop the request
 * underneath it — and no clock, which measures the wait without shortening it.
 */
export default function Working({ op, step }: WorkingProps): JSX.Element {
    const theme = useTheme()
    const entering = useEntering(entrances.body)

    return (
        <Animated.View entering={entering} style={{ gap: theme.spacing.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.md }}>
                <Icon name={OP_ICON[op]} size={24} color={theme.colors.accentInk} />
                <Text
                    style={{
                        ...theme.type.lg,
                        fontWeight: "700",
                        fontFamily: theme.face("700"),
                        color: theme.colors.ink
                    }}
                >
                    {OP_LABEL[op]}
                </Text>
            </View>
            <StepList steps={stepsFor(op, step)} />
            <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>Keep this app open.</Text>
        </Animated.View>
    )
}
