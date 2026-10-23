import CrossDeviceVerify from "./CrossDeviceVerify"
import { CODE_LINE } from "./verification-messages"
import type { CrossDeviceVerification } from "../use-cross-device-verification"
import type { JSX } from "react"
import { Text, TextInput, View } from "react-native"
import {
    Button,
    Card,
    Disclosure,
    FieldGroup,
    Header,
    Icon,
    KeyValue,
    Outcome,
    Screen,
    StepList,
    useTheme
} from "@coordination-network/app-ui"
import type { IconName, OutcomeTone, StepDetail } from "@coordination-network/app-ui"
import type { MemberFlows, VerifyOutcome, VerifyStage } from "@coordination-network/network-member-app-core"

/** The link client's own timeout message names no app; a person staring at this screen needs to know it means theirs. */
function failureLine(outcome: Extract<VerifyOutcome, { status: "failed" }>): string {
    return outcome.error.message.includes("timed out")
        ? "No answer from the wallet. Open it, then try again."
        : outcome.error.message
}

interface ResultView {
    tone: OutcomeTone
    icon: IconName
    title: string
    lines: string[]
    details: StepDetail[]
}

function resultView(outcome: VerifyOutcome): ResultView {
    switch (outcome.status) {
        case "verified":
            return {
                tone: "success",
                icon: "check-circle",
                title: "Eligible",
                lines: [`Valid ${outcome.programme} credential · ${outcome.country}`],
                details: [{ label: "Verification id", value: outcome.verificationId, mono: true }]
            }
        case "rejected": {
            const line = outcome.code ? CODE_LINE[outcome.code] : undefined
            const details: StepDetail[] = [{ label: "Verification id", value: outcome.verificationId, mono: true }]
            if (outcome.code) details.push({ label: "Code", value: outcome.code })
            return { tone: "danger", icon: "x-circle", title: "Not eligible", lines: line ? [line] : [], details }
        }
        case "failed":
            return {
                tone: "danger",
                icon: "x-circle",
                title: "Failed",
                lines: [failureLine(outcome)],
                details: [{ label: "Stage", value: outcome.stage }]
            }
    }
}

/** `mono` marks the hashes and ids, and those are the only values worth middle-truncating: a
 *  code or a stage is words, and words read as damage when their middle goes missing. */
function DetailRow({ detail }: { detail: StepDetail }): JSX.Element {
    return <KeyValue label={detail.label} value={detail.value} mono={detail.mono} truncate={detail.mono ?? false} />
}

interface CheckRowProps {
    label: string
}

function CheckRow({ label }: CheckRowProps): JSX.Element {
    const theme = useTheme()
    return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
            <Icon name="circle" size={16} color={theme.colors.muted} />
            <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>{label}</Text>
        </View>
    )
}

interface ScopeFieldProps {
    testID: string
    label: string
    value: string
    onChangeText: (value: string) => void
    autoCapitalize: "none" | "characters"
    maxLength: number
}

function ScopeField({ testID, label, value, onChangeText, autoCapitalize, maxLength }: ScopeFieldProps): JSX.Element {
    const theme = useTheme()
    return (
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
            <Text style={{ ...theme.type.xs, color: theme.colors.muted, textTransform: "uppercase" }}>{label}</Text>
            <TextInput
                testID={testID}
                accessibilityLabel={label}
                style={{
                    ...theme.type.sm,
                    color: theme.colors.ink,
                    borderColor: theme.colors.line,
                    borderWidth: 1,
                    borderRadius: theme.radii.sm,
                    padding: theme.spacing.md
                }}
                value={value}
                onChangeText={onChangeText}
                autoCapitalize={autoCapitalize}
                maxLength={maxLength}
            />
        </View>
    )
}

export interface VerifyScreenProps {
    flows: MemberFlows
    crossDevice: CrossDeviceVerification
    programme: string
    onProgrammeChange: (programme: string) => void
    country: string
    onCountryChange: (country: string) => void
    // Lifted into App (see there) so a glance at another tab, which unmounts this screen, doesn't
    // lose a verdict this org recorded, or a check still in flight.
    stage: VerifyStage | null
    onStageChange: (stage: VerifyStage | null) => void
    outcome: VerifyOutcome | null
    onOutcomeChange: (outcome: VerifyOutcome | null) => void
}

/** Flow 3 from the member's own view: ask the connected person to prove they qualify. */
export default function VerifyScreen({
    flows,
    crossDevice,
    programme,
    onProgrammeChange,
    country,
    onCountryChange,
    stage,
    onStageChange,
    outcome,
    onOutcomeChange
}: VerifyScreenProps): JSX.Element {
    const theme = useTheme()

    const running = stage !== null

    async function run(): Promise<void> {
        onOutcomeChange(null)
        onStageChange("presentationRequests")
        try {
            onOutcomeChange(await flows.verify({ programme, country, onStage: onStageChange }))
        } finally {
            onStageChange(null)
        }
    }

    const view = outcome === null ? null : resultView(outcome)
    // A verdict is this org's own record of one presentation, not a state to poll: tapping Check
    // again would open a whole new presentation request rather than re-read this one, so the button
    // that produced the verdict goes away. A failure is the exception - nothing was recorded, and
    // trying again is the recovery - so there Check stays where it was.
    const settled = view !== null && outcome?.status !== "failed"

    if (crossDevice.visible)
        return (
            <Screen scroll>
                <Header title="Check eligibility" />
                <CrossDeviceVerify
                    verification={crossDevice}
                    programme={programme}
                    country={country}
                    onBack={crossDevice.close}
                />
            </Screen>
        )

    return (
        <Screen scroll>
            <Header title="Check eligibility" />
            <View style={{ gap: theme.spacing.lg, marginTop: theme.spacing.lg }}>
                {running ? (
                    <StepList
                        steps={[
                            {
                                key: "ask",
                                title: "Asking the wallet",
                                state: stage === "verifications" ? "done" : "running"
                            },
                            {
                                key: "check",
                                title: "Checking the proof",
                                state: stage === "verifications" ? "running" : "idle"
                            }
                        ]}
                    />
                ) : null}

                {!running && view === null ? (
                    <Card>
                        <CheckRow label="Holds a valid credential" />
                        <CheckRow label={programme} />
                        <CheckRow label={`Country ${country}`} />
                    </Card>
                ) : null}

                {!running && view !== null ? (
                    <View>
                        <Outcome
                            testID="verify-outcome"
                            tone={view.tone}
                            icon={view.icon}
                            title={view.title}
                            lines={view.lines}
                        />
                        <Disclosure testID="verify-details">
                            <FieldGroup>
                                {view.details.map((detail) => (
                                    <DetailRow key={detail.label} detail={detail} />
                                ))}
                            </FieldGroup>
                        </Disclosure>
                    </View>
                ) : null}

                {settled ? (
                    <Button testID="check-again" label="Check again" variant="secondary" onPress={() => void run()} />
                ) : (
                    <Button
                        testID="run-verify"
                        label={running ? "Checking…" : "Check"}
                        loading={running}
                        onPress={() => void run()}
                    />
                )}

                {!running ? (
                    <Button
                        testID="verify-another-phone"
                        label="Check another phone"
                        variant="secondary"
                        onPress={crossDevice.open}
                    />
                ) : null}

                {!running && view === null ? (
                    <Disclosure testID="verify-settings">
                        <View style={{ flexDirection: "row", gap: theme.spacing.md }}>
                            <ScopeField
                                testID="verify-programme"
                                label="Programme"
                                value={programme}
                                onChangeText={onProgrammeChange}
                                autoCapitalize="none"
                                maxLength={64}
                            />
                            <ScopeField
                                testID="verify-country"
                                label="Country"
                                value={country}
                                onChangeText={onCountryChange}
                                autoCapitalize="characters"
                                maxLength={3}
                            />
                        </View>
                    </Disclosure>
                ) : null}
            </View>
        </Screen>
    )
}
