import { Fragment } from "react"
import type { JSX } from "react"
import { Text, View } from "react-native"
import Animated from "react-native-reanimated"
import {
    Button,
    Disclosure,
    entrances,
    FieldGroup,
    KeyValue,
    StepList,
    useEntering,
    useTheme
} from "@coordination-network/app-ui"
import type { ConsentSummary } from "@coordination-network/user-app-core"
import type { LinkOp } from "@coordination-network/user-app-link"
import { callbackOf, CALLBACK_LABEL } from "../members"
import type { ResolvedMember } from "../members"
import Member from "./Member"
import { stepsFor } from "./steps"

export interface ConsentProps {
    summary: ConsentSummary
    /** The stack member the caller is, or null when nothing in the stack vouches for its name. */
    member: ResolvedMember | null
    onApprove: () => void
    onDeny: () => void
}

/** Names the operation in the wallet's own words. Nothing in a request can change this. */
const OPERATION_HEADING: Record<LinkOp, string> = {
    "registration.sign": "Share your identity",
    "credential.issue": "Store a credential",
    "presentation.create": "Prove with your credential"
}

/** One sentence, with `member` nested where the calling member is named. */
function sentenceFor(summary: ConsentSummary, member: JSX.Element): JSX.Element {
    switch (summary.op) {
        case "registration.sign":
            return (
                <Fragment>
                    Share your network ID and signature with {member} to register your identity on chain.
                </Fragment>
            )

        case "credential.issue":
            return (
                <Fragment>
                    {member} is issuing you a {summary.scope.programme} credential for {summary.scope.country}.
                </Fragment>
            )

        case "presentation.create":
            return (
                <Fragment>
                    Prove to {member} that you hold a {summary.scope.programme} credential for {summary.scope.country}.
                </Fragment>
            )
    }
}

/**
 * The consent gate's body, hosted by App's single `Sheet` (see App.tsx) so approving hands off to
 * `Working` without the sheet itself unmounting. The heading leads, naming the operation from
 * `OPERATION_HEADING` rather than anything in `summary` — a caller can shape everything below it
 * but not this. One sentence follows, written here rather than in `user-app-core` so that the
 * caller can be named mid-line in its own colour, and only when the caller's name and callback
 * scheme both match a member of the loaded stack. Every technical value waits behind the
 * disclosure — except the callback of a caller nothing vouches for, which leads instead: the
 * sentence names that caller in its own words, and this is the line that says where the answer
 * really goes.
 */
export default function Consent({ summary, member, onApprove, onDeny }: ConsentProps): JSX.Element {
    const theme = useTheme()
    const entering = useEntering(entrances.body)
    const memberEl = <Member member={member} callerName={summary.caller.name} />
    const unvouched = member === null
    const folded = unvouched ? summary.details.filter(({ label }) => label !== CALLBACK_LABEL) : summary.details

    return (
        <Animated.View entering={entering} style={{ gap: theme.spacing.md }}>
            <Text
                style={{ ...theme.type.xl, fontWeight: "700", fontFamily: theme.face("700"), color: theme.colors.ink }}
            >
                {OPERATION_HEADING[summary.op]}
            </Text>
            {/* Never clipped: a sentence cut mid-word is worse than one that runs to two lines. */}
            <Text style={{ ...theme.type.md, color: theme.colors.ink }}>{sentenceFor(summary, memberEl)}</Text>

            {summary.op === "credential.issue" ? <StepList steps={stepsFor(summary.op, null)} /> : null}

            {unvouched ? <KeyValue label={CALLBACK_LABEL} value={callbackOf(summary)} truncate={false} /> : null}

            <Disclosure>
                <FieldGroup>
                    {folded.map((detail) => (
                        <KeyValue
                            key={detail.label}
                            label={detail.label}
                            value={detail.value}
                            truncate={detail.truncate}
                        />
                    ))}
                </FieldGroup>
            </Disclosure>

            <View style={{ flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.sm }}>
                <View style={{ flex: 1 }}>
                    <Button testID="consent-deny" label="Deny" variant="secondary" onPress={onDeny} />
                </View>
                <View style={{ flex: 1 }}>
                    <Button testID="consent-approve" label="Approve" onPress={onApprove} />
                </View>
            </View>
        </Animated.View>
    )
}
