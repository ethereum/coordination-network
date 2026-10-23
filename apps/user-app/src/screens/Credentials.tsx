import { useCallback, useEffect, useRef, useState } from "react"
import type { JSX } from "react"
import { ActivityIndicator, AppState, RefreshControl, Text, View } from "react-native"
import {
    Badge,
    Card,
    Disclosure,
    EmptyState,
    FieldGroup,
    Header,
    KeyValue,
    MemberName,
    Screen,
    useTheme
} from "@coordination-network/app-ui"
import type { BadgeTone } from "@coordination-network/app-ui"
import type { HeldCredential, UserAppService } from "@coordination-network/user-app-core"
import type { StackDescriptor } from "../config"
import { resolveIssuer, shortNetworkId } from "../members"

// Revocation is in here now: the whole network revokes into one registry, so this screen has a
// single authority to ask and asking it names no issuer. Issuer approval still isn't - an
// approved-issuer set is each member's own, so there is nobody to ask for a listing like this.
const STATUS_LABEL: Record<HeldCredential["status"], string> = {
    valid: "Valid",
    revoked: "Revoked",
    "not-yet-valid": "Not yet valid",
    expired: "Expired",
    unchecked: "Not checked"
}

const STATUS_TONE: Record<HeldCredential["status"], BadgeTone> = {
    valid: "success",
    revoked: "danger",
    "not-yet-valid": "warning",
    expired: "neutral",
    unchecked: "warning"
}

function formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleDateString()
}

export interface CredentialsScreenProps {
    service: UserAppService
    stack: StackDescriptor | null
}

/** Held credentials, each in the colour of the org that issued it. */
export default function CredentialsScreen({ service, stack }: CredentialsScreenProps): JSX.Element {
    const theme = useTheme()
    const [credentials, setCredentials] = useState<HeldCredential[] | null>(null)
    const [hasIdentity, setHasIdentity] = useState(false)
    const [refreshing, setRefreshing] = useState(false)

    const loadCredentials = useCallback(async () => {
        const [held, onboarded] = await Promise.all([service.listCredentials(), service.isOnboarded()])
        setCredentials(held)
        setHasIdentity(onboarded)
    }, [service])

    useEffect(() => {
        void loadCredentials()
    }, [loadCredentials])

    // A revocation happens elsewhere - an operator on the dashboard - so nothing on the phone
    // announces it. Re-reading when the person comes back to the app is what makes a card that
    // was revoked while they were away say so, without polling the network in the background.
    const reload = useRef(loadCredentials)
    reload.current = loadCredentials
    useEffect(() => {
        const subscription = AppState.addEventListener("change", (state) => {
            if (state === "active") void reload.current()
        })
        return () => subscription.remove()
    }, [])

    const refresh = useCallback(async () => {
        setRefreshing(true)
        try {
            await loadCredentials()
        } finally {
            setRefreshing(false)
        }
    }, [loadCredentials])

    if (credentials === null) {
        return (
            <Screen>
                <ActivityIndicator color={theme.colors.accentInk} />
            </Screen>
        )
    }

    return (
        <Screen
            scroll
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => void refresh()}
                    tintColor={theme.colors.accentInk}
                    colors={[theme.colors.accentInk]}
                />
            }
        >
            <View style={{ gap: theme.spacing.lg }}>
                <Header title="Credentials" />
                {credentials.length === 0 ? (
                    <EmptyState
                        icon="credit-card"
                        title="No credentials yet"
                        body={hasIdentity ? "An org issues one after you register." : "Create your identity first."}
                    />
                ) : (
                    <View style={{ gap: theme.spacing.lg }}>
                        {credentials.map((credential) => {
                            const issuer = resolveIssuer(stack, credential.issuerNetworkId)
                            return (
                                <Card
                                    key={credential.id}
                                    brand={issuer?.brand}
                                    voided={credential.status === "revoked"}
                                    header={
                                        <View
                                            style={{
                                                flexDirection: "row",
                                                alignItems: "center",
                                                justifyContent: "space-between",
                                                gap: theme.spacing.sm
                                            }}
                                        >
                                            {/* An org the loaded stack cannot name gets no colour and
                                                no stripe: the wallet will not dress up an issuer it
                                                can't place. */}
                                            {issuer === null ? (
                                                <Text
                                                    style={{
                                                        ...theme.type.lg,
                                                        fontWeight: "700",
                                                        fontFamily: theme.face("700"),
                                                        color: theme.colors.ink
                                                    }}
                                                >
                                                    {shortNetworkId(credential.issuerNetworkId)}
                                                </Text>
                                            ) : (
                                                <MemberName name={issuer.name} brand={issuer.brand} size="lg" />
                                            )}
                                            <Badge
                                                label={STATUS_LABEL[credential.status]}
                                                tone={STATUS_TONE[credential.status]}
                                            />
                                        </View>
                                    }
                                >
                                    {/* Labelled, and never truncated: "demo-programme" and "ZZZ" say
                                        nothing on their own, and `KeyValue` shortens any value past
                                        eleven characters, which is the middle of this programme's name. */}
                                    <FieldGroup>
                                        <KeyValue
                                            label="Programme"
                                            value={credential.programme}
                                            truncate={false}
                                            hint="The programme the org issued this for."
                                        />
                                        <KeyValue
                                            label="Country"
                                            value={credential.country}
                                            truncate={false}
                                            hint="Where the programme runs, as a three-letter country code."
                                        />
                                        <KeyValue
                                            label="Valid"
                                            value={`${formatDate(credential.notBefore)} – ${formatDate(credential.expiresAt)}`}
                                            truncate={false}
                                        />
                                    </FieldGroup>
                                    {credential.status === "unchecked" ? (
                                        <Text style={{ ...theme.type.xs, color: theme.colors.muted }}>
                                            {stack === null
                                                ? "Load a stack on the Config tab to check whether this is still live."
                                                : "The network could not be reached to check whether this is still live."}
                                        </Text>
                                    ) : null}
                                    <Disclosure testID="credential-details">
                                        <FieldGroup>
                                            <KeyValue label="Credential id" value={credential.id} mono />
                                            <KeyValue label="Programme hash" value={credential.programmeHash} mono />
                                            <KeyValue
                                                label="Issuer network ID"
                                                value={credential.issuerNetworkId}
                                                mono
                                            />
                                        </FieldGroup>
                                    </Disclosure>
                                </Card>
                            )
                        })}
                    </View>
                )}
            </View>
        </Screen>
    )
}
