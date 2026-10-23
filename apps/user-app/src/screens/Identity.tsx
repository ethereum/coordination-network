import { useCallback, useEffect, useState } from "react"
import type { JSX } from "react"
import { ActivityIndicator, Text, View } from "react-native"
import {
    Button,
    Card,
    EmptyState,
    FieldGroup,
    Header,
    KeyValue,
    Outcome,
    Screen,
    useTheme
} from "@coordination-network/app-ui"
import { metaStealthAddressUri } from "@coordination-network/identity"
import type { PublicIdentity, UserAppService } from "@coordination-network/user-app-core"
import { readIsRegistered } from "../chain-reads"
import type { StackDescriptor } from "../config"
import { registrationStatus } from "./identity-status"

export interface IdentityScreenProps {
    service: UserAppService
    stack: StackDescriptor | null
}

/**
 * `PublicIdentity`'s four displayed fields, read through the service, plus this app's own
 * read of whether the identity is registered. Security level is shown as-is — this app reports
 * it, it never gates anything on it (fail-closed policy lives elsewhere). Each row carries a
 * one-sentence hint behind an info icon, so the screen itself stays five short lines.
 */
export default function IdentityScreen({ service, stack }: IdentityScreenProps): JSX.Element {
    const theme = useTheme()
    const [identity, setIdentity] = useState<PublicIdentity | null>(null)
    const [loading, setLoading] = useState(true)
    const [creating, setCreating] = useState(false)
    const [justCreated, setJustCreated] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [registered, setRegistered] = useState<boolean | null>(null)
    const [chainUnreachable, setChainUnreachable] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const onboarded = await service.isOnboarded()
            setIdentity(onboarded ? await service.readIdentity() : null)
            setError(null)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setLoading(false)
        }
    }, [service])

    useEffect(() => {
        void load()
    }, [load])

    // Chain-read failures (phone off the LAN, anvil restarted) degrade to "Chain unreachable",
    // not a thrown error.
    useEffect(() => {
        if (identity === null || stack === null) {
            setRegistered(null)
            setChainUnreachable(false)
            return undefined
        }
        let cancelled = false
        setRegistered(null)
        setChainUnreachable(false)
        readIsRegistered(stack.rpcUrl, stack.identityRegistry, identity.networkId)
            .then((isRegistered) => {
                if (!cancelled) setRegistered(isRegistered)
            })
            .catch(() => {
                if (!cancelled) setChainUnreachable(true)
            })
        return () => {
            cancelled = true
        }
    }, [identity, stack])

    const handleCreate = useCallback(async () => {
        setCreating(true)
        setError(null)
        try {
            setIdentity(await service.createIdentity())
            setJustCreated(true)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setCreating(false)
        }
    }, [service])

    if (loading) {
        return (
            <Screen>
                <ActivityIndicator color={theme.colors.accentInk} />
            </Screen>
        )
    }

    if (identity === null) {
        return (
            <Screen>
                <View style={{ gap: theme.spacing.lg }}>
                    <Header title="Identity" />
                    <EmptyState
                        icon="user-plus"
                        title="Create your identity"
                        body="It stays on this phone."
                        action={
                            <Button
                                testID="create-identity"
                                label="Create identity"
                                onPress={() => void handleCreate()}
                                loading={creating}
                            />
                        }
                    />
                    {error !== null ? (
                        <Text style={{ ...theme.type.sm, color: theme.colors.danger }}>{error}</Text>
                    ) : null}
                </View>
            </Screen>
        )
    }

    return (
        <Screen scroll>
            <View style={{ gap: theme.spacing.lg }}>
                <Header title="Identity" />
                {/* Only for the run that created it: a returning person is not setting anything up. */}
                {justCreated ? (
                    <Outcome
                        tone="success"
                        icon="check-circle"
                        title="Setup complete"
                        lines={["You can now register for network members' services"]}
                    />
                ) : null}
                <Card>
                    <FieldGroup>
                        <KeyValue
                            label="Network ID"
                            value={identity.networkId}
                            mono
                            hint="Your public name on the network."
                        />
                        <KeyValue
                            label="Meta-stealth address"
                            value={metaStealthAddressUri(identity.metaStealthAddress)}
                            mono
                            hint="Where orgs can pay you privately."
                        />
                        <KeyValue
                            label="Account public key"
                            value={identity.accountPublicKey}
                            mono
                            hint="Signs for your account."
                        />
                        <KeyValue
                            label="Security level"
                            value={identity.securityLevel}
                            hint="How this phone guards your keys."
                        />
                        <KeyValue
                            label="Registration"
                            value={registrationStatus({ hasStack: stack !== null, registered, chainUnreachable }).label}
                            truncate={false}
                            hint="Whether you are on chain yet."
                        />
                    </FieldGroup>
                </Card>
            </View>
        </Screen>
    )
}
