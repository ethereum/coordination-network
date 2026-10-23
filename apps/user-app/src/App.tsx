import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { JSX } from "react"
import { ActivityIndicator, Text, View } from "react-native"
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context"
import { useFonts } from "expo-font"
import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular"
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular"
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium"
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold"
import { IBMPlexSans_700Bold } from "@expo-google-fonts/ibm-plex-sans/700Bold"
import { StatusBar } from "expo-status-bar"
import { KEYSTORE_ERROR_CODES, keystoreErrorCode } from "@coordination-network/expo-identity-keystore"
import {
    AppBar,
    Button,
    Card,
    EmptyState,
    Screen,
    Sheet,
    TabBar,
    ThemeProvider,
    useTheme
} from "@coordination-network/app-ui"
import type { TabBarItem } from "@coordination-network/app-ui"
import {
    createUserAppService,
    type ConsentSummary,
    type PresentationReview,
    type RevocationAuthority,
    type UserAppPorts,
    type UserAppService
} from "@coordination-network/user-app-core"
import type { LinkOp } from "@coordination-network/user-app-link"
import { createDeviceKey, eraseDeviceKey, replaceDeviceKeys, type DeviceKeyOptions } from "./adapters/device-key"
import { createMemberDirectory, createRootAuthority, readIsRevoked } from "./chain-reads"
import { createDeviceStore, eraseDeviceStore } from "./adapters/store"
import { httpClient } from "./adapters/http"
import { createProver } from "./adapters/prover"
import { readStackConfig, type StackDescriptor } from "./config"
import { createLinkSubscription, type LinkSubscription } from "./link"
import { callbackOf, resolveIssuer, resolveMember } from "./members"
import Consent from "./screens/Consent"
import ConfigScreen from "./screens/Config"
import CredentialsScreen from "./screens/Credentials"
import IdentityScreen from "./screens/Identity"
import SettingsScreen from "./screens/Settings"
import ShareProof from "./screens/ShareProof"
import ScanProof from "./screens/ScanProof"
import { presentScannedQr } from "./presentation"
import Working from "./screens/Working"

type Tab = "scan" | "credentials" | "identity" | "config" | "settings"

const APP_NAME = "User wallet"

const CREDENTIALS_CLEARED_NOTICE =
    "Credentials on this phone were cleared. Your registration is kept. Ask your organisation to re-issue them."

/** The boot failures a person can fix, in words that say how; anything else shows its own message. */
function bootErrorMessage(error: unknown): string {
    switch (keystoreErrorCode(error)) {
        case KEYSTORE_ERROR_CODES.noSecureLockScreen:
            return "Set a screen lock to use this wallet"
        case KEYSTORE_ERROR_CODES.unsupportedPlatform:
            return "This wallet needs Android 12 or newer"
        default:
            return error instanceof Error ? error.message : String(error)
    }
}

/** Non-fatal: it runs again next boot. The warning carries no credential contents or ids. */
async function reconcileCredentials(service: UserAppService): Promise<number> {
    try {
        return await service.removeUnboundCredentials()
    } catch {
        console.warn("Could not check stored credentials against the device keys; will retry at next start.")
        return 0
    }
}

const TABS: TabBarItem<Tab>[] = [
    { key: "scan", label: "Scan proof", icon: "camera" },
    { key: "credentials", label: "Credentials", icon: "credit-card" },
    { key: "identity", label: "Identity", icon: "user" },
    { key: "config", label: "Config", icon: "sliders" },
    { key: "settings", label: "Settings", icon: "settings" }
]

/**
 * The person's crypto core: no business logic, just the three `user-app-link` operations any
 * network member app can call, each behind a consent screen. Boots the native ports (device key,
 * prover), wires the deep-link handler, and switches between four screens with no router — this
 * app is small enough that one isn't worth the dependency.
 */
export default function App(): JSX.Element {
    // Not a gate: the first frame draws in the platform's own face and swaps when these arrive.
    // The key each is registered under is the family name a style asks for (app-ui's `SANS_FACES`).
    // Imported per weight rather than from the package index, which `require`s all fourteen sans
    // weights and their italics - about 5 MB of faces this app never draws.
    const [fontsLoaded] = useFonts({
        IBMPlexSans_400Regular,
        IBMPlexSans_500Medium,
        IBMPlexSans_600SemiBold,
        IBMPlexSans_700Bold,
        IBMPlexMono_400Regular
    })

    return (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <ThemeProvider fontsLoaded={fontsLoaded}>
                <AppShell />
            </ThemeProvider>
        </SafeAreaProvider>
    )
}

function AppShell(): JSX.Element {
    const theme = useTheme()
    const [ports, setPorts] = useState<UserAppPorts | null>(null)
    const [service, setService] = useState<UserAppService | null>(null)
    const [stack, setStack] = useState<StackDescriptor | null>(null)
    // The same descriptor as `stack`, reachable from a closure that outlives any one render: the
    // revocation port below is built once, at boot, and must still read whatever stack is loaded
    // now - one saved on the Config tab, or none at all after an erase.
    const stackRef = useRef<StackDescriptor | null>(null)
    const [bootError, setBootError] = useState<string | null>(null)
    // Set when the device keys were replaced and the credentials bound to the old ones were cleared.
    const [notice, setNotice] = useState<string | null>(null)
    // The ports behind the current service, reachable from the device key's `onInvalidated`, which
    // is built once and outlives any one render.
    const portsRef = useRef<UserAppPorts | null>(null)
    const [tab, setTab] = useState<Tab>("credentials")
    const [pendingSummary, setPendingSummary] = useState<ConsentSummary | null>(null)
    // `null` shows Consent; an op switches the same sheet to Working. Set from Approve onward and
    // cleared by `onWorking(null)` — see the sheet render below for why `pendingSummary` itself
    // stays around that whole time instead of clearing on Approve.
    const [workingOp, setWorkingOp] = useState<LinkOp | null>(null)
    // The last step a handler reported; `Working` turns it into a position in the op's step list.
    const [workingStep, setWorkingStep] = useState<string | null>(null)
    // The second gate, on presentations only: what a proof would reveal, asked before it is built.
    const [pendingReview, setPendingReview] = useState<PresentationReview | null>(null)
    const requestBusy = useRef(false)
    const pendingResolve = useRef<((approved: boolean) => void) | null>(null)
    const reviewResolve = useRef<((approved: boolean) => void) | null>(null)

    // The single consent gate every deep link passes through (see service.consent in link.ts).
    // Stable across the app's lifetime: link.ts already serializes requests, so at most one
    // prompt is ever pending.
    const consent = useCallback((summary: ConsentSummary): Promise<boolean> => {
        if (requestBusy.current) return Promise.resolve(false)
        requestBusy.current = true
        return new Promise((resolve) => {
            pendingResolve.current = resolve
            setPendingSummary(summary)
        })
    }, [])

    const review = useCallback((summary: PresentationReview): Promise<boolean> => {
        return new Promise((resolve) => {
            reviewResolve.current = resolve
            setPendingReview(summary)
        })
    }, [])

    const onWorking = useCallback((op: LinkOp | null): void => {
        if (op === null) requestBusy.current = false
        setWorkingOp(op)
        // Fires before the handler runs, so a new request always starts on its first step.
        setWorkingStep(null)
        if (op === null) setPendingSummary(null)
    }, [])

    const progress = useCallback((op: LinkOp, step: string): void => setWorkingStep(step), [])

    const applyStack = useCallback((descriptor: StackDescriptor | null): void => {
        stackRef.current = descriptor
        setStack(descriptor)
    }, [])

    /**
     * The network's one revocation registry, which is the only authority a mixed-issuer listing
     * can ask - and asking it names no issuer. `null` when no stack is configured: the listing then
     * says it has not checked, rather than calling a credential valid on its dates alone.
     */
    const revocations = useMemo<RevocationAuthority>(
        () => ({
            isRevoked: async (commitment: bigint) => {
                const current = stackRef.current
                if (current === null) return null
                return readIsRevoked(
                    current.rpcUrl,
                    current.revocation.address,
                    BigInt(current.revocation.registryId),
                    commitment
                )
            }
        }),
        []
    )

    const directory = useMemo(() => createMemberDirectory(() => stackRef.current), [])
    const roots = useMemo(() => createRootAuthority(() => stackRef.current), [])

    // The adapter's options are built once, so they reach the current render's recovery through a ref.
    const recover = useRef<() => Promise<void>>(async () => undefined)
    // The recovery in flight: an invalidation reported while the keys are being replaced joins it.
    const recovery = useRef<Promise<void> | null>(null)
    const deviceKeyOptions = useRef<DeviceKeyOptions>({
        onInvalidated: () => {
            recovery.current ??= recover.current().finally(() => {
                recovery.current = null
            })
        }
    })
    // The live link subscription, so a recovery can detach it at once rather than on the next render.
    const linkSubscription = useRef<LinkSubscription | null>(null)

    // A key use found the screen lock gone or reset. Only the device keys are replaced: never
    // `eraseDeviceKey`, which also deletes SecureStore's key and the device secret with it. The
    // failing request ends on its own.
    const recoverFromInvalidatedKey = async (): Promise<void> => {
        const current = portsRef.current
        if (current === null) return
        // A queued link must not start on the old service while its keys are being deleted.
        linkSubscription.current?.remove()
        setService(null)
        try {
            const deviceKey = await replaceDeviceKeys(deviceKeyOptions.current)
            const rebuiltPorts: UserAppPorts = { ...current, deviceKey }
            const rebuiltService = createUserAppService(rebuiltPorts)
            const removed = await reconcileCredentials(rebuiltService)
            portsRef.current = rebuiltPorts
            setPorts(rebuiltPorts)
            setService(rebuiltService)
            if (removed > 0) setNotice(CREDENTIALS_CLEARED_NOTICE)
        } catch (error) {
            // The next launch provisions whatever keys are missing and its boot reconciles.
            setBootError(bootErrorMessage(error))
        }
    }
    recover.current = recoverFromInvalidatedKey

    useEffect(() => {
        let cancelled = false

        async function boot(): Promise<void> {
            try {
                const store = createDeviceStore()
                const [deviceKey, proofGenerator, loadedStack] = await Promise.all([
                    createDeviceKey(deviceKeyOptions.current),
                    createProver(),
                    readStackConfig()
                ])
                if (cancelled) return

                const builtPorts: UserAppPorts = {
                    store,
                    deviceKey,
                    minimumDeviceSecurityLevel: __DEV__ ? "SOFTWARE" : "TRUSTED_ENVIRONMENT",
                    proofGenerator,
                    http: httpClient,
                    consent,
                    review,
                    directory,
                    roots,
                    revocations,
                    progress
                }
                const builtService = createUserAppService(builtPorts)
                const onboarded = await builtService.isOnboarded()
                // Credentials bound to keys that are gone are removed and the person is told. Done
                // at every boot, so a recovery killed half way is finished by the next launch.
                if (onboarded && (await reconcileCredentials(builtService)) > 0) {
                    setNotice(CREDENTIALS_CLEARED_NOTICE)
                }
                // Nothing else works until an identity exists, so the first launch opens on the
                // screen that creates one; every later launch opens on what the person holds.
                setTab(onboarded ? "credentials" : "identity")
                portsRef.current = builtPorts
                setPorts(builtPorts)
                setService(builtService)
                applyStack(loadedStack)
            } catch (error) {
                if (!cancelled) setBootError(bootErrorMessage(error))
            }
        }

        void boot()
        return () => {
            cancelled = true
        }
    }, [applyStack, consent, directory, progress, review, revocations, roots])

    // Every incoming deep link is served here for the app's whole lifetime.
    useEffect(() => {
        if (service === null) return undefined
        const subscription = createLinkSubscription({
            handlers: service.handlers,
            consent: service.consent,
            isBusy: () => requestBusy.current,
            onWorking
        })
        linkSubscription.current = subscription
        return () => subscription.remove()
    }, [service, onWorking])

    function handleStackSaved(descriptor: StackDescriptor): void {
        applyStack(descriptor)
    }

    if (service === null || ports === null) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
                <StatusBar style="light" />
                <AppBar name={APP_NAME} />
                <Screen>
                    {bootError !== null ? (
                        <EmptyState title="The app could not start" body={bootError} />
                    ) : (
                        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                            <ActivityIndicator color={theme.colors.accentInk} />
                        </View>
                    )}
                </Screen>
            </View>
        )
    }

    // eraseDeviceKey() deletes both native keys; the old `ports.deviceKey` object still refers to
    // their aliases, so it's stale until fresh ones are generated too.
    const handleErased = async (): Promise<void> => {
        // `service.erase()` clears the whole shared store, which includes the stack descriptor.
        // Leaving `stack` set would show Config a descriptor no longer on disk, and it would
        // vanish on the next launch instead.
        applyStack(null)
        const deviceKey = await createDeviceKey(deviceKeyOptions.current)
        const rebuiltPorts: UserAppPorts = { ...ports, deviceKey }
        portsRef.current = rebuiltPorts
        setPorts(rebuiltPorts)
        setService(createUserAppService(rebuiltPorts))
    }

    const respondToConsent = (approved: boolean): void => {
        pendingResolve.current?.(approved)
        pendingResolve.current = null
        // A denial closes the sheet outright; an approval hands off to Working, which clears
        // `pendingSummary` itself once `onWorking(null)` arrives (see `onWorking` above).
        if (!approved) {
            requestBusy.current = false
            setPendingSummary(null)
        }
    }

    const respondToReview = (approved: boolean): void => {
        reviewResolve.current?.(approved)
        reviewResolve.current = null
        // Either answer hands the flow back to the handler, which is still running underneath.
        setPendingReview(null)
    }

    const callingMember =
        pendingSummary === null ? null : resolveMember(stack, pendingSummary.caller, callbackOf(pendingSummary))

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
            <StatusBar style="light" />
            <AppBar name={APP_NAME} />

            {notice !== null ? (
                <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}>
                    <Card title="Credentials cleared">
                        <Text style={{ ...theme.type.sm, color: theme.colors.ink }}>{notice}</Text>
                        <Button
                            testID="notice-dismiss"
                            label="Dismiss"
                            variant="secondary"
                            onPress={() => setNotice(null)}
                        />
                    </Card>
                </View>
            ) : null}

            <View style={{ flex: 1 }}>
                {tab === "scan" ? (
                    <ScanProof
                        isBusy={() => requestBusy.current}
                        onPresent={(raw) => presentScannedQr(raw, stack, service, onWorking, httpClient)}
                    />
                ) : null}
                {tab === "credentials" ? <CredentialsScreen service={service} stack={stack} /> : null}
                {tab === "identity" ? <IdentityScreen service={service} stack={stack} /> : null}
                {tab === "config" ? <ConfigScreen stack={stack} onSaved={handleStackSaved} /> : null}
                {tab === "settings" ? (
                    <SettingsScreen
                        service={service}
                        eraseDeviceStore={eraseDeviceStore}
                        eraseDeviceKey={eraseDeviceKey}
                        onErased={handleErased}
                    />
                ) : null}
            </View>

            <TabBar items={TABS} activeKey={tab} onSelect={setTab} />

            {pendingSummary !== null ? (
                // One `Sheet` (a native Modal) for the whole request: Consent, Working and
                // ShareProof are just its body, swapped in place, so approving never dismisses
                // and re-presents the dialog the way rendering three separate `Sheet`s would.
                <Sheet
                    visible
                    brand={APP_NAME}
                    onRequestClose={workingOp === null ? () => respondToConsent(false) : undefined}
                >
                    {pendingReview !== null ? (
                        <ShareProof
                            review={pendingReview}
                            member={callingMember}
                            issuer={resolveIssuer(stack, pendingReview.issuerNetworkId)}
                            callerName={pendingSummary.caller.name}
                            onShare={() => respondToReview(true)}
                            onRefuse={() => respondToReview(false)}
                        />
                    ) : workingOp !== null ? (
                        <Working op={workingOp} step={workingStep} />
                    ) : (
                        <Consent
                            summary={pendingSummary}
                            member={callingMember}
                            onApprove={() => respondToConsent(true)}
                            onDeny={() => respondToConsent(false)}
                        />
                    )}
                </Sheet>
            ) : null}
        </View>
    )
}
