import { useState } from "react"
import type { JSX } from "react"
import { ActivityIndicator, Pressable, Text, View } from "react-native"
import Animated from "react-native-reanimated"
import { useTheme } from "../tokens"
import type { Theme } from "../tokens"
import { entrances, useEntering } from "../motion"
import Icon from "./Icon"
import type { IconName } from "./Icon"
import KeyValue from "./KeyValue"

export type StepState = "idle" | "running" | "done" | "existing" | "failed"

export interface StepDetail {
    label: string
    value: string
    /** For hashes, ids and addresses, as `KeyValue`'s `mono`. */
    mono?: boolean
}

export interface Step {
    key: string
    title: string
    oneLiner?: string
    state: StepState
    details?: StepDetail[]
}

export interface StepListProps {
    steps: Step[]
}

const STATE_ICON: Record<Exclude<StepState, "running">, IconName> = {
    idle: "circle",
    done: "check",
    // A record that was already there is not this run's success, so it never takes the check.
    existing: "users",
    failed: "x"
}

const STATE_LABEL: Record<StepState, string> = {
    idle: "not started",
    running: "in progress",
    done: "done",
    existing: "already on the network",
    failed: "failed"
}

function stateColor(theme: Theme, state: StepState): string {
    switch (state) {
        case "done":
            return theme.colors.success
        case "failed":
            return theme.colors.danger
        case "running":
        case "existing":
            return theme.colors.accentInk
        case "idle":
            return theme.colors.muted
    }
}

interface StepRowProps {
    index: number
    step: Step
}

function StepRow({ index, step }: StepRowProps): JSX.Element {
    const theme = useTheme()
    const [detailsOpen, setDetailsOpen] = useState(false)
    const color = stateColor(theme, step.state)
    const hasDetails = (step.details?.length ?? 0) > 0
    const entering = useEntering(entrances.step)

    return (
        <View style={{ flexDirection: "row", gap: theme.spacing.md }}>
            <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: theme.colors.canvas,
                    alignItems: "center",
                    justifyContent: "center"
                }}
            >
                <Text
                    style={{
                        ...theme.type.sm,
                        fontWeight: "700",
                        fontFamily: theme.face("700"),
                        color: theme.colors.muted
                    }}
                >
                    {index + 1}
                </Text>
            </View>
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
                <View
                    accessible
                    accessibilityLabel={[
                        `Step ${index + 1}: ${step.title}.`,
                        step.oneLiner,
                        `${STATE_LABEL[step.state]}.`
                    ]
                        .filter(Boolean)
                        .join(" ")}
                    importantForAccessibility="no-hide-descendants"
                    style={{ gap: theme.spacing.xs }}
                >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.xs }}>
                        {/* Keyed by state, so reaching the next state remounts the marker and it
                            enters rather than swapping in place. */}
                        <Animated.View key={step.state} entering={entering}>
                            {step.state === "running" ? (
                                <ActivityIndicator size="small" color={color} testID={`step-${step.key}-spinner`} />
                            ) : (
                                <Icon name={STATE_ICON[step.state]} size={16} color={color} />
                            )}
                        </Animated.View>
                        <Text
                            style={{
                                ...theme.type.md,
                                fontWeight: "600",
                                fontFamily: theme.face("600"),
                                color: theme.colors.ink
                            }}
                        >
                            {step.title}
                        </Text>
                    </View>
                    {step.oneLiner ? (
                        <Text style={{ ...theme.type.sm, color: theme.colors.muted }}>{step.oneLiner}</Text>
                    ) : null}
                </View>
                {hasDetails ? (
                    <Pressable
                        testID={`step-${step.key}-toggle`}
                        onPress={() => setDetailsOpen((open) => !open)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: detailsOpen }}
                        hitSlop={8}
                        android_ripple={{ color: `${theme.colors.ink}14` }}
                    >
                        <Text
                            style={{
                                ...theme.type.xs,
                                color: theme.colors.accentInk,
                                fontWeight: "600",
                                fontFamily: theme.face("600")
                            }}
                        >
                            {detailsOpen ? "Hide details" : "Details"}
                        </Text>
                    </Pressable>
                ) : null}
                {detailsOpen
                    ? step.details?.map((detail) => (
                          <KeyValue key={detail.label} label={detail.label} value={detail.value} mono={detail.mono} />
                      ))
                    : null}
            </View>
        </View>
    )
}

/** A flow's steps, numbered top to bottom, each carrying its own lifecycle state and detail rows. */
export default function StepList({ steps }: StepListProps): JSX.Element {
    const theme = useTheme()

    return (
        <View style={{ gap: theme.spacing.lg }}>
            {steps.map((step, index) => (
                <StepRow key={step.key} index={index} step={step} />
            ))}
        </View>
    )
}
