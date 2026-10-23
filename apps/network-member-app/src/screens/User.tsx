import { useEffect, useRef, useState } from "react"
import type { JSX } from "react"
import { Text, View } from "react-native"
import Animated from "react-native-reanimated"
import {
    Badge,
    Button,
    Disclosure,
    Icon,
    FieldGroup,
    KeyValue,
    MemberName,
    Outcome,
    Screen,
    StepList,
    entrances,
    useEntering,
    useTheme
} from "@coordination-network/app-ui"
import type {
    EnrolOutcome,
    IssueOutcome,
    MemberFlows,
    MembershipOutcome
} from "@coordination-network/network-member-app-core"
import { brand, business } from "../business"
import {
    enrolledSubject,
    issueOutcomeView,
    issueStepState,
    notAdmitted,
    registerOutcomeView,
    registerStepState
} from "./user-status"
import type { OutcomeView } from "./user-status"

export type Running = "register" | "issue" | null

export interface UserScreenProps {
    flows: MemberFlows
    // Lifted into App (see there) so a glance at another tab, which unmounts this screen, doesn't
    // lose a completed registration or issuance, or a flow still in flight.
    registerOutcome: EnrolOutcome | null
    onRegisterOutcome: (outcome: EnrolOutcome | null) => void
    issueOutcome: IssueOutcome | null
    onIssueOutcome: (outcome: IssueOutcome | null) => void
    running: Running
    onRunningChange: (running: Running) => void
}

// The intro is an app-launch moment, not a per-tab one, and this screen unmounts every time
// someone glances at Activity. Module scope is what survives that.
let introPlayed = false

/** True only when `present` turned true while this screen was mounted: a reveal the person
 *  watched happen animates, a remount from a tab switch doesn't. */
function useRevealed(present: boolean): boolean {
    const presentOnMount = useRef(present)
    return present && !presentOnMount.current
}

interface OutcomeBlockProps {
    view: OutcomeView
    testID: string
    entering: boolean
    children?: JSX.Element | null
}

/** An `Outcome`, anything the flow adds under it, and its rows folded away. */
function OutcomeBlock({ view, testID, entering, children }: OutcomeBlockProps): JSX.Element {
    return (
        <View>
            <Outcome
                testID={testID}
                tone={view.tone}
                icon={view.icon}
                title={view.title}
                lines={view.lines}
                entering={entering}
            />
            {children}
            {view.details.length > 0 ? (
                <Disclosure testID={`${testID}-details`}>
                    <FieldGroup>
                        {view.details.map((detail) => (
                            // `mono` marks the hashes and ids, and those are the only values worth
                            // middle-truncating: a stage is words, and words read as damage when
                            // their middle goes missing.
                            <KeyValue
                                key={detail.label}
                                label={detail.label}
                                value={detail.value}
                                mono={detail.mono}
                                truncate={detail.mono ?? false}
                            />
                        ))}
                    </FieldGroup>
                </Disclosure>
            ) : null}
        </View>
    )
}

/** Flows 2 and 4 from the member's own view: register the connected person, then issue them a credential. */
export default function UserScreen({
    flows,
    registerOutcome,
    onRegisterOutcome,
    issueOutcome,
    onIssueOutcome,
    running,
    onRunningChange
}: UserScreenProps): JSX.Element {
    const theme = useTheme()
    const [membership, setMembership] = useState<MembershipOutcome | null>(null)
    const [playIntro] = useState(() => {
        const first = !introPlayed
        introPlayed = true
        return first
    })

    useEffect(() => {
        void flows.membershipStatus().then(setMembership)
    }, [flows])

    async function runRegister(): Promise<void> {
        onRunningChange("register")
        try {
            onRegisterOutcome(await flows.enrol())
        } finally {
            onRunningChange(null)
        }
    }

    async function runIssue(): Promise<void> {
        const subject = enrolledSubject(registerOutcome)
        if (subject === null) return
        onRunningChange("issue")
        try {
            onIssueOutcome(await flows.issue({ subject }))
        } finally {
            onRunningChange(null)
        }
    }

    function startOver(): void {
        onRegisterOutcome(null)
        onIssueOutcome(null)
    }

    const canRegister = registerOutcome === null || registerOutcome.status === "failed"
    const canIssue = enrolledSubject(registerOutcome) !== null && issueOutcome === null
    // Register and Issue are mutually exclusive: this is true only once both have run out of a
    // next step - a settled issuance (issued, already held, or failed), or a settled-but-unissuable
    // registration (refused) - leaving neither button to press.
    const canStartOver = !canRegister && !canIssue
    const registerView = registerOutcomeView(registerOutcome)
    const issueView = issueOutcomeView(issueOutcome)
    const sponsored = registerOutcome?.status === "registered" && registerOutcome.sponsorship !== undefined

    const entering = useEntering(entrances.body)
    const issueRevealed = useRevealed(canIssue)
    const registerOutcomeRevealed = useRevealed(registerView !== null)
    const issueOutcomeRevealed = useRevealed(issueView !== null)

    return (
        <Screen scroll>
            <View style={{ gap: theme.spacing.xl, marginTop: theme.spacing.xl }}>
                {registerView === null ? (
                    <Animated.View
                        entering={playIntro ? entering : undefined}
                        style={{ alignItems: "center", gap: theme.spacing.md }}
                    >
                        <MemberName name={business.branding.displayName} brand={brand} size="xl" />
                        <Icon name="user-plus" size={40} color={theme.colors.accentInk} />
                        <Text style={{ ...theme.type.md, color: theme.colors.ink }}>Register a wallet</Text>
                        {notAdmitted(membership) ? <Badge label="Not admitted yet" tone="warning" /> : null}
                    </Animated.View>
                ) : (
                    <StepList
                        steps={[
                            {
                                key: "register",
                                title: "Register",
                                state: running === "register" ? "running" : registerStepState(registerOutcome)
                            },
                            {
                                key: "issue",
                                title: "Issue",
                                state: running === "issue" ? "running" : issueStepState(issueOutcome)
                            }
                        ]}
                    />
                )}

                {registerView !== null ? (
                    <OutcomeBlock view={registerView} testID="register-outcome" entering={registerOutcomeRevealed}>
                        {sponsored ? (
                            <View
                                style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: theme.spacing.xs
                                }}
                            >
                                <Icon name="zap" size={14} color={theme.colors.muted} />
                                <Text style={{ ...theme.type.sm, color: theme.colors.muted }}>
                                    Gas paid by the Semaphore paymaster
                                </Text>
                            </View>
                        ) : null}
                    </OutcomeBlock>
                ) : null}

                {issueView !== null ? (
                    <OutcomeBlock view={issueView} testID="issue-outcome" entering={issueOutcomeRevealed} />
                ) : null}

                {canRegister ? (
                    <Button
                        testID="run-register"
                        label={running === "register" ? "Registering…" : "Register"}
                        loading={running === "register"}
                        onPress={() => void runRegister()}
                    />
                ) : null}
                {canIssue ? (
                    <Animated.View entering={issueRevealed ? entering : undefined} style={{ gap: theme.spacing.sm }}>
                        <Text style={{ ...theme.type.sm, color: theme.colors.muted, textAlign: "center" }}>
                            Reusable later to prove identity privately.
                        </Text>
                        <Button
                            testID="run-issue"
                            label={running === "issue" ? "Issuing…" : "Issue a credential"}
                            loading={running === "issue"}
                            onPress={() => void runIssue()}
                        />
                    </Animated.View>
                ) : null}
                {canStartOver ? (
                    <Button testID="start-over" label="Start over" variant="secondary" onPress={startOver} />
                ) : null}
            </View>
        </Screen>
    )
}
