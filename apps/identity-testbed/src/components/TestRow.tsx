import type { JSX } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native"

import type { Check, Tier } from "../tests/types"

/** Lifecycle of a single test case as tracked by the app. */
export type CaseStatus = "idle" | "running" | "pass" | "fail"

const TIER_LABEL: Record<Tier, string> = {
    js: "JS",
    device: "DEVICE",
    keystore: "KEYSTORE"
}

const STATUS_GLYPH: Record<CaseStatus, string> = {
    idle: "○",
    running: "…",
    pass: "✓",
    fail: "✗"
}

export interface TestRowProps {
    /** Case id — the primary label. */
    id: string
    /** One-line "what this proves" subtitle. */
    description: string
    tier: Tier
    /** Group accent colour (the row's left edge). */
    accent: string
    status: CaseStatus
    ms: number
    checks: Check[]
    /** Context that isn't an assertion (pinned constants, timings). */
    note?: string
    expanded: boolean
    /** When set, the row renders this message and isn't runnable (e.g. keystore tier without the module). */
    unavailableReason?: string
    /** Runs this case. No-op while any case is running (single-flight, enforced by the caller). */
    onPress: () => void
}

/** One row in the test list: id, subtitle, status, and an expandable list of per-check results. */
export default function TestRow({
    id,
    description,
    tier,
    accent,
    status,
    ms,
    checks,
    note,
    expanded,
    unavailableReason,
    onPress
}: TestRowProps): JSX.Element {
    const disabled = unavailableReason !== undefined || status === "running"
    const passed = checks.filter((entry) => entry.ok).length
    const ran = status === "pass" || status === "fail"

    let detailSection: JSX.Element | null = null
    if (unavailableReason !== undefined) {
        detailSection = <Text style={styles.unavailable}>{unavailableReason}</Text>
    } else if (expanded && checks.length > 0) {
        detailSection = (
            <View style={styles.detail}>
                {checks.map((entry, index) => (
                    // Checks are a fixed, re-rendered-in-full array per run — index is a stable key here.
                    <View key={`${index}-${entry.label}`} style={styles.check}>
                        <Text style={[styles.checkGlyph, entry.ok ? styles.checkPass : styles.checkFail]}>
                            {entry.ok ? "✓" : "✗"}
                        </Text>
                        <View style={styles.checkBody}>
                            <Text style={styles.checkLabel}>{entry.label}</Text>
                            {entry.detail !== undefined ? <Text style={styles.checkDetail}>{entry.detail}</Text> : null}
                        </View>
                    </View>
                ))}
                {note !== undefined ? <Text style={styles.note}>{note}</Text> : null}
            </View>
        )
    }

    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            style={({ pressed }) => [
                styles.row,
                { borderLeftColor: accent },
                pressed && !disabled ? styles.rowPressed : null
            ]}
        >
            <View style={styles.header}>
                <View style={styles.tierBadge}>
                    <Text style={styles.tierBadgeText}>{TIER_LABEL[tier]}</Text>
                </View>
                <View style={styles.titleBlock}>
                    <Text style={styles.id}>{id}</Text>
                    <Text style={styles.description}>{description}</Text>
                </View>
                {ran && checks.length > 0 ? (
                    <Text style={styles.count}>
                        {passed}/{checks.length}
                    </Text>
                ) : null}
                {status === "running" ? (
                    <ActivityIndicator size="small" />
                ) : (
                    <Text style={[styles.glyph, styles[`glyph_${status}`]]}>{STATUS_GLYPH[status]}</Text>
                )}
                {ran ? <Text style={styles.ms}>{ms.toFixed(1)}ms</Text> : null}
            </View>

            {detailSection}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    row: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#333",
        borderLeftWidth: 3,
        paddingVertical: 10,
        paddingLeft: 12,
        paddingRight: 12
    },
    rowPressed: {
        backgroundColor: "#1c1c1e"
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        gap: 8
    },
    tierBadge: {
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
        backgroundColor: "#2c2c2e"
    },
    tierBadgeText: {
        fontSize: 10,
        fontWeight: "700",
        color: "#8e8e93",
        letterSpacing: 0.5
    },
    titleBlock: {
        flex: 1,
        gap: 1
    },
    id: {
        fontFamily: "monospace",
        fontSize: 14,
        fontWeight: "600",
        color: "#f2f2f7"
    },
    description: {
        fontSize: 11,
        color: "#8e8e93"
    },
    count: {
        fontFamily: "monospace",
        fontSize: 11,
        color: "#8e8e93"
    },
    glyph: {
        fontSize: 16,
        fontWeight: "700",
        minWidth: 18,
        textAlign: "center"
    },
    glyph_idle: {
        color: "#636366"
    },
    glyph_running: {
        color: "#636366"
    },
    glyph_pass: {
        color: "#30d158"
    },
    glyph_fail: {
        color: "#ff453a"
    },
    ms: {
        fontSize: 12,
        color: "#8e8e93",
        minWidth: 56,
        textAlign: "right"
    },
    detail: {
        marginTop: 8,
        marginLeft: 42,
        gap: 6
    },
    check: {
        flexDirection: "row",
        gap: 8
    },
    checkGlyph: {
        fontSize: 12,
        fontWeight: "700",
        lineHeight: 16,
        minWidth: 12,
        textAlign: "center"
    },
    checkPass: {
        color: "#30d158"
    },
    checkFail: {
        color: "#ff453a"
    },
    checkBody: {
        flex: 1,
        gap: 1
    },
    checkLabel: {
        fontSize: 12,
        color: "#d1d1d6"
    },
    checkDetail: {
        fontFamily: "monospace",
        fontSize: 10,
        color: "#8e8e93"
    },
    note: {
        fontFamily: "monospace",
        fontSize: 10,
        color: "#636366",
        marginTop: 2
    },
    unavailable: {
        marginTop: 6,
        marginLeft: 42,
        fontSize: 12,
        fontStyle: "italic",
        color: "#8e8e93"
    }
})
