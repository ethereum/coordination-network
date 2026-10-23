import { useMemo, useRef, useState } from "react"
import type { JSX } from "react"
import {
    Platform,
    Pressable,
    SafeAreaView,
    ScrollView,
    StatusBar as RNStatusBar,
    StyleSheet,
    Text,
    View
} from "react-native"
import { StatusBar } from "expo-status-bar"

// Relative import — the SDK's `exports` map has no subpath for `package.json`.
import identityPackageJson from "../../../packages/identity/package.json"
import type { CaseStatus } from "./components/TestRow"
import TestRow from "./components/TestRow"
import { createTestContext } from "./tests/context"
import { GROUPS } from "./tests/groups"
import { allCases } from "./tests/index"
import type { Check, Tier } from "./tests/types"

interface CaseState {
    status: CaseStatus
    ms: number
    checks: Check[]
    note?: string
    expanded: boolean
}

const IDLE_STATE: CaseState = { status: "idle", ms: 0, checks: [], expanded: false }

function initialStates(): Record<string, CaseState> {
    const states: Record<string, CaseState> = {}

    for (const testCase of allCases) {
        states[testCase.id] = IDLE_STATE
    }

    return states
}

export default function App(): JSX.Element {
    // Built once so Keystore/secure-store handles stay stable across runs.
    const ctx = useMemo(() => createTestContext(), [])
    const [states, setStates] = useState<Record<string, CaseState>>(initialStates)
    const [isBusy, setIsBusy] = useState(false)
    // Checked synchronously in `runExclusive`; `isBusy` only updates between renders.
    const busyRef = useRef(false)

    function isUnavailable(tier: Tier): boolean {
        return tier === "keystore" && ctx.keystore === null
    }

    async function runOne(id: string): Promise<void> {
        const testCase = allCases.find((candidate) => candidate.id === id)

        if (!testCase || isUnavailable(testCase.tier)) {
            return
        }

        setStates((prev) => ({ ...prev, [id]: { ...prev[id], status: "running" } }))

        const detail = await testCase.run(ctx)

        setStates((prev) => ({
            ...prev,
            [id]: {
                status: detail.ok ? "pass" : "fail",
                ms: detail.ms,
                checks: detail.checks,
                note: detail.note,
                expanded: true
            }
        }))
    }

    // Keystore ops must never interleave — every runner goes through this guard.
    async function runExclusive(action: () => Promise<void>): Promise<void> {
        if (busyRef.current) {
            return
        }

        busyRef.current = true
        setIsBusy(true)

        try {
            await action()
        } finally {
            busyRef.current = false
            setIsBusy(false)
        }
    }

    async function handleRunSingle(id: string): Promise<void> {
        await runExclusive(() => runOne(id))
    }

    async function handleRunAll(): Promise<void> {
        await runExclusive(async () => {
            // Sequential on purpose: Keystore ops must not interleave.
            for (const testCase of allCases) {
                if (isUnavailable(testCase.tier)) {
                    continue
                }

                await runOne(testCase.id)
            }
        })
    }

    const summary = useMemo(() => {
        let passed = 0
        let failed = 0
        let skipped = 0

        for (const testCase of allCases) {
            if (isUnavailable(testCase.tier)) {
                skipped += 1
                continue
            }

            const status = states[testCase.id].status
            if (status === "pass") {
                passed += 1
            } else if (status === "fail") {
                failed += 1
            }
        }

        const runnable = allCases.length - skipped
        return { passed, failed, skipped, runnable, ran: passed + failed > 0 }
    }, [states, ctx])

    let summaryTone = styles.summaryIdle
    if (summary.failed > 0) {
        summaryTone = styles.summaryFail
    } else if (summary.ran && summary.passed === summary.runnable) {
        summaryTone = styles.summaryPass
    }

    const hermesEnabled = Boolean((globalThis as { HermesInternal?: unknown }).HermesInternal)
    const rngAvailable = typeof globalThis.crypto?.getRandomValues === "function"
    const keystoreAvailable = ctx.keystore !== null

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="light" />

            <View style={styles.headerBar}>
                <View>
                    <Text style={styles.title}>Identity Testbed</Text>
                    <Text style={styles.subtitle}>One nonce, three keys, three signatures</Text>
                </View>
                <Pressable
                    onPress={handleRunAll}
                    disabled={isBusy}
                    style={({ pressed }) => [styles.runAllButton, (isBusy || pressed) && styles.runAllButtonPressed]}
                >
                    <Text style={styles.runAllText}>{isBusy ? "Running…" : "Run all"}</Text>
                </Pressable>
            </View>

            <View style={[styles.summary, summaryTone]}>
                <Text style={styles.summaryText}>
                    {summary.ran
                        ? `${summary.passed} / ${summary.runnable} passed`
                        : `${summary.runnable} checks ready`}
                    {summary.skipped > 0 ? `  ·  ${summary.skipped} skipped` : ""}
                </Text>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {GROUPS.map((group) => {
                    const groupCases = allCases.filter((testCase) => testCase.group === group.key)

                    if (groupCases.length === 0) {
                        return null
                    }

                    return (
                        <View key={group.key}>
                            <View style={[styles.groupHeader, { borderLeftColor: group.accent }]}>
                                <View style={styles.groupTitleRow}>
                                    <Text style={[styles.groupTitle, { color: group.accent }]}>{group.title}</Text>
                                    {group.curve !== "" ? <Text style={styles.groupCurve}>{group.curve}</Text> : null}
                                </View>
                                <Text style={styles.groupRole}>{group.role}</Text>
                            </View>

                            {groupCases.map((testCase) => {
                                const state = states[testCase.id]
                                const unavailableReason = isUnavailable(testCase.tier)
                                    ? "unavailable — requires dev build"
                                    : undefined

                                return (
                                    <TestRow
                                        key={testCase.id}
                                        id={testCase.id}
                                        description={testCase.description}
                                        tier={testCase.tier}
                                        accent={group.accent}
                                        status={state.status}
                                        ms={state.ms}
                                        checks={state.checks}
                                        note={state.note}
                                        expanded={state.expanded}
                                        unavailableReason={unavailableReason}
                                        onPress={() => handleRunSingle(testCase.id)}
                                    />
                                )
                            })}
                        </View>
                    )
                })}
            </ScrollView>

            <View style={styles.footer}>
                <Text style={styles.footerLine}>
                    secp256k1 = enrolled account · P-256 = the curve hardware signs · Baby Jubjub = the ZK-circuit curve
                </Text>
                <Text style={styles.footerLine}>
                    Hermes: {hermesEnabled ? "yes" : "no"} · crypto.getRandomValues: {rngAvailable ? "yes" : "no"} ·
                    Keystore module: {keystoreAvailable ? "yes" : "no"} · SDK v{identityPackageJson.version}
                </Text>
            </View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#000",
        // Android draws edge-to-edge (SafeAreaView pads only iOS); keeps the header off the status bar.
        paddingTop: Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 0) : 0
    },
    headerBar: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#333"
    },
    title: {
        fontSize: 20,
        fontWeight: "700",
        color: "#f2f2f7"
    },
    subtitle: {
        fontSize: 11,
        color: "#8e8e93",
        marginTop: 2
    },
    runAllButton: {
        backgroundColor: "#0a84ff",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 16
    },
    runAllButtonPressed: {
        opacity: 0.6
    },
    runAllText: {
        color: "#fff",
        fontWeight: "600",
        fontSize: 14
    },
    summary: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderLeftWidth: 3,
        backgroundColor: "#0c0c0e"
    },
    summaryIdle: {
        borderLeftColor: "#636366"
    },
    summaryPass: {
        borderLeftColor: "#30d158"
    },
    summaryFail: {
        borderLeftColor: "#ff453a"
    },
    summaryText: {
        fontFamily: "monospace",
        fontSize: 13,
        fontWeight: "600",
        color: "#f2f2f7"
    },
    list: {
        flex: 1
    },
    listContent: {
        paddingBottom: 12
    },
    groupHeader: {
        borderLeftWidth: 3,
        paddingLeft: 12,
        paddingRight: 16,
        paddingTop: 14,
        paddingBottom: 6
    },
    groupTitleRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8
    },
    groupTitle: {
        fontSize: 13,
        fontWeight: "700",
        letterSpacing: 0.3
    },
    groupCurve: {
        fontFamily: "monospace",
        fontSize: 10,
        color: "#8e8e93"
    },
    groupRole: {
        fontSize: 11,
        color: "#8e8e93",
        marginTop: 2
    },
    footer: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: "#333",
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 2
    },
    footerLine: {
        fontSize: 11,
        color: "#8e8e93"
    }
})
