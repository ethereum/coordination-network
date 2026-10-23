import { useEffect, useMemo, useRef, useState } from "react"
import type { JSX } from "react"
import { ActivityIndicator, View } from "react-native"
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context"
import { useFonts } from "expo-font"
import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular"
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular"
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium"
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold"
import { IBMPlexSans_700Bold } from "@expo-google-fonts/ibm-plex-sans/700Bold"
import { StatusBar } from "expo-status-bar"
import { AppBar, Screen, TabBar, ThemeProvider, useTheme } from "@coordination-network/app-ui"
import type { TabBarItem } from "@coordination-network/app-ui"
import { createMemberFlows, createMemberServerClient } from "@coordination-network/network-member-app-core"
import type {
    EnrolOutcome,
    IssueOutcome,
    MemberFlows,
    VerifyOutcome,
    VerifyStage
} from "@coordination-network/network-member-app-core"
import { APPROVAL_SCOPE, brand, business } from "./business"
import { MEMBER_IDS, buildMemberConfig, clearStoredPairing, loadStoredPairing, memberId, storePairing } from "./config"
import type { Pairing } from "./config"
import { createMemberLinkClient } from "./link"
import ActivityScreen from "./screens/Activity"
import SettingsScreen from "./screens/Settings"
import SetupScreen from "./screens/Setup"
import UserScreen from "./screens/User"
import type { Running } from "./screens/User"
import VerifyScreen from "./screens/Verify"
import { useCrossDeviceVerification } from "./use-cross-device-verification"

type Tab = "user" | "verify" | "activity" | "settings"

const TABS: TabBarItem<Tab>[] = [
    { key: "user", label: "User", icon: "user" },
    { key: "verify", label: "Verify", icon: "shield" },
    { key: "activity", label: "Activity", icon: "activity" },
    { key: "settings", label: "Settings", icon: "settings" }
]

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
            <ThemeProvider brand={brand} fontsLoaded={fontsLoaded}>
                <AppShell />
            </ThemeProvider>
        </SafeAreaProvider>
    )
}

function AppShell(): JSX.Element {
    const theme = useTheme()
    const [pairing, setPairing] = useState<Pairing | null>(null)
    const [loadingStack, setLoadingStack] = useState(true)
    const [bootError, setBootError] = useState<string | null>(null)
    const [tab, setTab] = useState<Tab>("user")
    // Lifted out of UserScreen so a glance at another tab - which unmounts it - doesn't lose a
    // completed registration or issuance, or a flow still in flight.
    const [registerOutcome, setRegisterOutcome] = useState<EnrolOutcome | null>(null)
    const [issueOutcome, setIssueOutcome] = useState<IssueOutcome | null>(null)
    const [running, setRunning] = useState<Running>(null)
    // Lifted out of VerifyScreen for the same reason, and for one more: the screen stops offering
    // Check once a verdict is in, and that would come back every time the tab was left.
    const [programme, setProgramme] = useState(APPROVAL_SCOPE.programme)
    const [country, setCountry] = useState(APPROVAL_SCOPE.country)
    const [verifyStage, setVerifyStage] = useState<VerifyStage | null>(null)
    const [verifyOutcome, setVerifyOutcome] = useState<VerifyOutcome | null>(null)
    // Bumped whenever the active stack changes, so a flow still running under a previous stack -
    // its promise chain outlives the UserScreen instance that started it - can't write its outcome
    // (or clear `running`) onto a different stack's screen once it settles.
    const stackEpoch = useRef(0)

    useEffect(() => {
        loadStoredPairing()
            .then((loaded) => {
                // Validated the same way Setup does before ever storing one - a stack.json stored
                // before that guard existed can still be schema-valid but miss this member.
                if (loaded) buildMemberConfig(loaded, memberId, business.branding.displayName)
                setPairing(loaded)
            })
            .catch(async (err: unknown) => {
                // Unparseable, or schema-valid but missing this member: either way unusable, and
                // would otherwise keep failing on every future launch.
                try {
                    await clearStoredPairing()
                } catch {
                    // A failed clear shouldn't stop the boot error from showing; retried next launch.
                }
                setBootError(err instanceof Error ? err.message : String(err))
            })
            .finally(() => setLoadingStack(false))
    }, [])

    const config = useMemo(
        () => (pairing ? buildMemberConfig(pairing, memberId, business.branding.displayName) : null),
        [pairing]
    )

    // One `LinkClient` for the whole app: its single-flight guard (see `user-app-link`'s README)
    // only holds if every flow shares this instance instead of each opening its own.
    const flows: MemberFlows | null = useMemo(() => {
        if (!config) return null
        return createMemberFlows({
            config,
            link: createMemberLinkClient(business.branding.displayName),
            server: createMemberServerClient({
                baseUrl: config.serverUrl,
                fetch,
                memberServerToken: config.memberServerToken
            }),
            policy: business.policy,
            hooks: business.hooks
        })
    }, [config])

    const crossDevice = useCrossDeviceVerification(flows)

    async function handlePaired(next: Pairing): Promise<void> {
        await storePairing(next)
        stackEpoch.current += 1
        setBootError(null)
        setPairing(next)
    }

    async function handleChangeStack(): Promise<void> {
        await clearStoredPairing()
        stackEpoch.current += 1
        setPairing(null)
        // Otherwise a new stack inherits the old one's screen state.
        setRegisterOutcome(null)
        setIssueOutcome(null)
        setRunning(null)
        setVerifyStage(null)
        setVerifyOutcome(null)
    }

    if (loadingStack) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
                <StatusBar style="light" />
                <AppBar name={business.branding.displayName} />
                <Screen>
                    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                        {/* accentInk, not accent: the yellow accent is too light on canvas. */}
                        <ActivityIndicator color={theme.colors.accentInk} />
                    </View>
                </Screen>
            </View>
        )
    }

    if (!pairing || !flows || !config) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
                <StatusBar style="light" />
                <AppBar name={business.branding.displayName} />
                <SetupScreen onPaired={(next) => void handlePaired(next)} initialError={bootError} />
            </View>
        )
    }

    // Setup only ever stores a stack that already validated against this member (see its
    // StackConfigError catch), so `config` being built here proves this member's entry exists.
    const role = pairing.stack.members[MEMBER_IDS.indexOf(memberId)].role

    // Captures *this* render's epoch, so a setter from a flow that started under an earlier
    // stack - and settles after `stackEpoch` has moved on - is dropped instead of applied.
    const epoch = stackEpoch.current
    function forThisStack<T>(setter: (value: T) => void): (value: T) => void {
        return (value) => {
            if (epoch === stackEpoch.current) setter(value)
        }
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
            <StatusBar style="light" />
            <AppBar name={business.branding.displayName} />

            <View style={{ flex: 1 }}>
                {tab === "user" ? (
                    <UserScreen
                        flows={flows}
                        registerOutcome={registerOutcome}
                        onRegisterOutcome={forThisStack(setRegisterOutcome)}
                        issueOutcome={issueOutcome}
                        onIssueOutcome={forThisStack(setIssueOutcome)}
                        running={running}
                        onRunningChange={forThisStack(setRunning)}
                    />
                ) : null}
                {tab === "verify" ? (
                    <VerifyScreen
                        flows={flows}
                        crossDevice={crossDevice}
                        programme={programme}
                        onProgrammeChange={setProgramme}
                        country={country}
                        onCountryChange={setCountry}
                        stage={verifyStage}
                        onStageChange={forThisStack(setVerifyStage)}
                        outcome={verifyOutcome}
                        onOutcomeChange={forThisStack(setVerifyOutcome)}
                    />
                ) : null}
                {tab === "activity" ? <ActivityScreen /> : null}
                {tab === "settings" ? (
                    <SettingsScreen
                        flows={flows}
                        config={config}
                        role={role}
                        dashboardUrl={pairing.stack.dashboardUrl}
                        onChangeStack={() => void handleChangeStack()}
                    />
                ) : null}
            </View>

            <TabBar items={TABS} activeKey={tab} onSelect={setTab} />
        </View>
    )
}
