import { useEffect, useState } from "react"
import type { JSX } from "react"
import { Linking, Pressable, Text, View } from "react-native"
import {
    Badge,
    Button,
    Card,
    Disclosure,
    FieldGroup,
    Header,
    Icon,
    KeyValue,
    Screen,
    useTheme
} from "@coordination-network/app-ui"
import type { BadgeTone } from "@coordination-network/app-ui"
import type { MemberConfig, MemberFlows, MembershipOutcome } from "@coordination-network/network-member-app-core"
import { business } from "../business"
import type { MemberRole } from "../config"

export interface SettingsScreenProps {
    flows: MemberFlows
    config: MemberConfig
    role: MemberRole
    dashboardUrl: string
    onChangeStack: () => void
}

function roleBadge(role: MemberRole): { label: string; tone: BadgeTone } {
    return role === "founder" ? { label: "Founding org", tone: "accent" } : { label: "Candidate", tone: "neutral" }
}

function membershipBadge(membership: MembershipOutcome | null): { label: string; tone: BadgeTone } {
    if (membership === null) return { label: "Checking…", tone: "neutral" }
    if (membership.status === "failed") return { label: "Unable to check", tone: "neutral" }
    switch (membership.status) {
        case "none":
            return { label: "Not yet a member", tone: "neutral" }
        case "requested":
            return { label: "Requested", tone: "warning" }
        case "approved":
            return { label: "Approved", tone: "success" }
    }
}

function LinkRow({ testID, label, onPress }: { testID: string; label: string; onPress: () => void }): JSX.Element {
    const theme = useTheme()
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole="link"
            accessibilityLabel={label}
            android_ripple={{ color: `${theme.colors.ink}14` }}
            style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingVertical: theme.spacing.sm
            }}
        >
            <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>{label}</Text>
            <Icon name="external-link" size={16} color={theme.colors.muted} />
        </Pressable>
    )
}

/** This org's own identity, its membership as read from its status page, and where to manage both. */
export default function SettingsScreen({
    flows,
    config,
    role,
    dashboardUrl,
    onChangeStack
}: SettingsScreenProps): JSX.Element {
    const theme = useTheme()
    const [membership, setMembership] = useState<MembershipOutcome | null>(null)

    useEffect(() => {
        void flows.membershipStatus().then(setMembership)
    }, [flows])

    return (
        <Screen scroll>
            <Header title="Settings" />
            <View style={{ gap: theme.spacing.lg, marginTop: theme.spacing.lg }}>
                <Card title="Identity">
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                        <Text
                            style={{
                                ...theme.type.md,
                                fontWeight: "700",
                                fontFamily: theme.face("700"),
                                color: theme.colors.ink
                            }}
                        >
                            {business.branding.displayName}
                        </Text>
                        <Badge {...roleBadge(role)} />
                    </View>
                    <Disclosure testID="settings-network-id">
                        <KeyValue label="Network ID" value={config.networkId} mono />
                    </Disclosure>
                </Card>

                <Card title="Membership">
                    <Badge {...membershipBadge(membership)} />
                    {membership !== null && membership.status !== "failed" ? (
                        <Disclosure testID="settings-membership-details">
                            <FieldGroup>
                                <KeyValue label="Safe" value={membership.safe.address} mono />
                                <KeyValue
                                    label="Threshold"
                                    value={`${membership.safe.threshold} of ${membership.safe.owners.length}`}
                                    truncate={false}
                                />
                                <KeyValue
                                    label="Identity registered"
                                    value={membership.identityRegistered ? "Yes" : "No"}
                                />
                                <KeyValue
                                    label="Issuer key published"
                                    value={membership.issuerKeyPublished ? "Yes" : "No"}
                                />
                            </FieldGroup>
                        </Disclosure>
                    ) : null}
                    {membership !== null && membership.status === "failed" ? (
                        <Text style={{ ...theme.type.sm, color: theme.colors.muted }}>{membership.error.message}</Text>
                    ) : null}
                </Card>

                <Card title="Links">
                    <LinkRow
                        testID="open-status-page"
                        label="This org's status page"
                        onPress={() => void Linking.openURL(config.serverUrl)}
                    />
                    <LinkRow
                        testID="open-dashboard"
                        label="Network dashboard"
                        onPress={() => void Linking.openURL(dashboardUrl)}
                    />
                </Card>

                <Button testID="change-stack" label="Change stack" variant="secondary" onPress={onChangeStack} />
            </View>
        </Screen>
    )
}
