import type { JSX } from "react"
import { StyleSheet, Text, View } from "react-native"
import Animated from "react-native-reanimated"
import {
    Button,
    entrances,
    FieldGroup,
    Icon,
    KeyValue,
    Outcome,
    useEntering,
    useTheme
} from "@coordination-network/app-ui"
import type { IconName } from "@coordination-network/app-ui"
import type { PresentationReview } from "@coordination-network/user-app-core"
import type { ResolvedMember } from "../members"
import Member from "./Member"

/**
 * What a presentation never carries, whatever it is a presentation of. "Which member issued it" is on
 * this list because the proof carries the whole approved set's root and one network-wide revocation
 * root, so nothing it sends names the issuer. A verifier that serves a doctored approved-issuer set
 * can still infer it from whether the wallet answers at all; closing that needs the wallet to take
 * the set from somewhere other than the verifier, which it does not yet.
 */
const HIDDEN = ["Who you are", "Which member issued it", "Your other credentials", "Your network ID"]

export interface ShareProofProps {
    review: PresentationReview
    /** The verifier as the request's caller, resolved against the stack. */
    member: ResolvedMember | null
    /** The member that issued the credential, resolved against the stack. */
    issuer: ResolvedMember | null
    callerName: string
    onShare: () => void
    onRefuse: () => void
}

interface FactsProps {
    label: string
    icon: IconName
    /** The group's own colour, on its label and its glyphs. */
    tone: string
    /** A translucent wash in `tone`; a group without one is recessed onto the canvas instead. */
    washed?: boolean
    lines: string[]
}

interface AnswersProps {
    refuse: string
    accept: string
    onShare: () => void
    onRefuse: () => void
}

/**
 * One bounded, labelled group of facts. The two groups on this screen have to be told apart from
 * across a room, before either list is read, so the difference is carried by a border, a wash and
 * a named label rather than by a glyph on each row.
 */
function Facts({ label, icon, tone, washed = false, lines }: FactsProps): JSX.Element {
    const theme = useTheme()

    return (
        <View
            style={{
                backgroundColor: washed ? theme.colors.surface : theme.colors.canvas,
                borderColor: theme.colors.line,
                borderWidth: 1,
                borderRadius: theme.radii.md,
                borderCurve: "continuous",
                padding: theme.spacing.md,
                gap: theme.spacing.sm,
                overflow: "hidden"
            }}
        >
            {/* A translucent layer rather than an alpha suffix on the colour string, so the wash
                works whatever format `tone` is in - the same approach `Card` and `Badge` take. */}
            {washed ? (
                <View
                    pointerEvents="none"
                    style={{ ...StyleSheet.absoluteFillObject, backgroundColor: tone, opacity: 0.07 }}
                />
            ) : null}
            <Text style={{ ...theme.type.sm, fontWeight: "600", fontFamily: theme.face("600"), color: tone }}>
                {label}
            </Text>
            {lines.map((line) => (
                <View key={line} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
                    <Icon name={icon} size={16} color={tone} />
                    <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>{line}</Text>
                </View>
            ))}
        </View>
    )
}

function Answers({ refuse, accept, onShare, onRefuse }: AnswersProps): JSX.Element {
    const theme = useTheme()

    return (
        <View style={{ flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.sm }}>
            <View style={{ flex: 1 }}>
                <Button testID="share-refuse" label={refuse} variant="secondary" onPress={onRefuse} />
            </View>
            <View style={{ flex: 1 }}>
                <Button testID="share-proof" label={accept} onPress={onShare} />
            </View>
        </View>
    )
}

/**
 * The second gate, hosted by App's single `Sheet` (see App.tsx). A proof asks before it is built,
 * because nothing has been proved or has left the phone yet and it is the person's to share: the
 * screen shows what it would reveal. Approving is what leads to the device prompt that signs it.
 *
 * A revoked credential only reports, and the screen says what telling the verifier discloses.
 * Do not give it a refusal: `refusalCode` recognises only `CREDENTIAL_REVOKED` and
 * `NO_CREDENTIAL`, so a `CONSENT_DENIED` reaches the verifier as nothing at all and leaves its
 * request unresolved until it expires. `user-app-core` still honours a refusal, for the web app
 * that offers one.
 */
export default function ShareProof({
    review,
    member,
    issuer,
    callerName,
    onShare,
    onRefuse
}: ShareProofProps): JSX.Element {
    const theme = useTheme()
    const entering = useEntering(entrances.body)
    const memberEl = <Member member={member} callerName={callerName} />
    const heading = { ...theme.type.md, color: theme.colors.ink }
    const verifierName = member?.name ?? callerName

    if (review.kind === "revoked") {
        return (
            <Animated.View entering={entering} style={{ gap: theme.spacing.md }}>
                <Outcome tone="danger" icon="x-circle" title="Credential revoked" entering={false} />

                <Text style={heading}>
                    <Member member={issuer} callerName="A network member" /> revoked your {review.programme} credential,
                    so it can no longer prove anything.
                </Text>

                <FieldGroup>
                    <KeyValue label="Programme" value={review.programme} truncate={false} />
                    <KeyValue label="Country" value={review.country} truncate={false} />
                </FieldGroup>

                {/* Said, not asked. The verifier does learn something here - that this person was
                    asked and holds a revoked credential for that scope - so it is named rather than
                    left implied. */}
                <Text style={{ ...theme.type.xs, color: theme.colors.muted }}>
                    {verifierName} is told the credential was revoked, so the check it asked for gets an answer.
                </Text>

                <Button testID="revoked-ack" label="Done" onPress={onShare} />
            </Animated.View>
        )
    }

    return (
        <Animated.View entering={entering} style={{ gap: theme.spacing.md }}>
            {/* This body already animates in as a whole - a second, independent entrance on the
                Outcome nested inside it would replay the fade over the one already running. */}
            <Outcome tone="success" icon="shield" title="Ready to prove" entering={false} />

            {/* Which credential answered, for the person and no one else. A wallet holding one from
                each of two members for the same programme can prove with either, and picks by expiry
                rather than by issuer - deliberately, since choosing by issuer is what would give
                the issuer away. Saying so here is the difference between that and a wallet that
                looks like it ignored a revocation. */}
            {issuer === null ? (
                <Text style={heading}>Using the credential you hold for this programme.</Text>
            ) : (
                <Text style={heading}>
                    Using your <Member member={issuer} callerName={issuer.name} /> credential.
                </Text>
            )}

            {/* Two groups, each naming the verifier, stacked. The member is named in the labels rather
                than drawn by `Member` there: a coloured name at its own size inside a group label
                would outrank the label carrying it. */}
            <Facts
                label={`Shared with ${verifierName}`}
                icon="check"
                tone={theme.colors.success}
                washed
                lines={[`You hold a valid ${review.programme} credential`, `Country ${review.country}`]}
            />

            <Facts label={`Hidden from ${verifierName}`} icon="eye-off" tone={theme.colors.muted} lines={HIDDEN} />

            <Text style={heading}>Share the proof with {memberEl}?</Text>

            <Answers refuse="Don't share" accept="Share" onShare={onShare} onRefuse={onRefuse} />
        </Animated.View>
    )
}
