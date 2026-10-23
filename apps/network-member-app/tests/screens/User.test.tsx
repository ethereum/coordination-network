import { describe, expect, it, jest } from "@jest/globals"
import { useState } from "react"
import type { JSX } from "react"
import { allText, press, renderScreen } from "@coordination-network/app-ui/testing"
import { act } from "react-test-renderer"
import type {
    EnrolOutcome,
    IssueOutcome,
    MemberFlows,
    MembershipStatusResponse
} from "@coordination-network/network-member-app-core"
import UserScreen from "../../src/screens/User"
import type { Running } from "../../src/screens/User"
import { buildFlows, createFakeLinkClient, hex, openDisclosure } from "../support"

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
}

function membership(overrides: Partial<MembershipStatusResponse> = {}): MembershipStatusResponse {
    return {
        status: "approved",
        networkId: hex(32, "aa"),
        authAddress: hex(20, "bb"),
        governanceSigner: hex(20, "ee"),
        metaStealthAddress: hex(66, "22"),
        safe: { address: hex(20, "cc"), threshold: 1, owners: [hex(20, "bb")] },
        identityRegistered: true,
        issuerKeyPublished: true,
        ...overrides
    }
}

const networkId = hex(32, "11")
const metaStealthAddress = hex(66, "22")

const registrationSignResult = {
    request: {
        version: "v1" as const,
        networkId,
        schemeId: 1 as const,
        metaStealthAddress,
        chainId: 1,
        verifyingContract: hex(20, "44"),
        signature: hex(65, "55")
    },
    securityLevel: "SOFTWARE" as const
}

interface HarnessProps {
    flows: MemberFlows
    onIssueOutcome?: (outcome: IssueOutcome | null) => void
    // Mirrors App.tsx conditionally rendering UserScreen per tab: false unmounts UserScreen while
    // this Harness instance (standing in for App) keeps its own state, as a real tab switch does.
    showUser?: boolean
}

/** Holds `registerOutcome`/`issueOutcome`/`running` the way App.tsx does, so these tests exercise UserScreen as the controlled component it now is. */
function Harness({ flows, onIssueOutcome, showUser = true }: HarnessProps): JSX.Element {
    const [registerOutcome, setRegisterOutcome] = useState<EnrolOutcome | null>(null)
    const [issueOutcome, setIssueOutcome] = useState<IssueOutcome | null>(null)
    const [running, setRunning] = useState<Running>(null)

    if (!showUser) return <></>

    return (
        <UserScreen
            flows={flows}
            registerOutcome={registerOutcome}
            onRegisterOutcome={setRegisterOutcome}
            issueOutcome={issueOutcome}
            onIssueOutcome={(outcome) => {
                setIssueOutcome(outcome)
                onIssueOutcome?.(outcome)
            }}
            running={running}
            onRunningChange={setRunning}
        />
    )
}

describe("UserScreen", () => {
    it("opens on an intro naming this org, with Register and no Issue button", async () => {
        const flows = buildFlows({ server: { getMembership: async () => membership() } })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()

        const text = allText(tree)
        expect(text).toContain("Member A")
        expect(text).toContain("Register a wallet")
        // `deep: false` stops a match from recursing into Button's own internal Pressable and View,
        // which carry the same testID and would otherwise inflate a count of 1 button to 4 matches.
        expect(tree.root.findAllByProps({ testID: "run-register" }, { deep: false })).toHaveLength(1)
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
    })

    it("badges an org that isn't admitted yet, but still allows registering", async () => {
        const flows = buildFlows({ server: { getMembership: async () => membership({ status: "requested" }) } })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()

        expect(allText(tree)).toContain("Not admitted yet")
        expect(tree.root.findAllByProps({ testID: "run-register" }, { deep: false })).toHaveLength(1)
    })

    it("shows no badge once this org is admitted", async () => {
        const flows = buildFlows({ server: { getMembership: async () => membership({ status: "approved" }) } })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()

        expect(allText(tree)).not.toContain("Not admitted yet")
    })

    it("keeps the register button mounted, showing its loading label, while registering", async () => {
        let resolveSign!: (value: typeof registrationSignResult) => void
        const link = createFakeLinkClient({
            "registration.sign": () =>
                new Promise((resolve) => {
                    resolveSign = resolve
                })
        })
        const flows = buildFlows({ link, server: { getMembership: async () => membership() } })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()

        await act(() => {
            tree.root.findByProps({ testID: "run-register" }).props.onPress()
        })

        // While loading, Button swaps its label text for a spinner - the label lives on as the
        // accessibility name instead (see Button's own doc comment), which is what stays reachable here.
        const [button] = tree.root.findAllByProps({ testID: "run-register" }, { deep: false })
        expect(button.props.label).toBe("Registering…")
        expect(button.props.loading).toBe(true)

        await act(async () => {
            resolveSign(registrationSignResult)
            await flush()
        })
    })

    it("keeps the issue button mounted, showing its loading label, while issuing", async () => {
        let resolveIssue!: (value: { status: "stored"; credentialId: string }) => void
        const link = createFakeLinkClient({
            "registration.sign": async () => registrationSignResult,
            "credential.issue": () =>
                new Promise((resolve) => {
                    resolveIssue = resolve
                })
        })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)

        await act(() => {
            tree.root.findByProps({ testID: "run-issue" }).props.onPress()
        })

        const [button] = tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })
        expect(button.props.label).toBe("Issuing…")
        expect(button.props.loading).toBe(true)

        await act(async () => {
            resolveIssue({ status: "stored", credentialId: "urn:uuid:cred-1" })
            await flush()
        })
    })

    it("keeps showing the register button as loading across a remount, and doesn't start a second registration", async () => {
        let signCalls = 0
        let resolveSign!: (value: typeof registrationSignResult) => void
        const link = createFakeLinkClient({
            "registration.sign": () => {
                signCalls += 1
                return new Promise((resolve) => {
                    resolveSign = resolve
                })
            }
        })
        const flows = buildFlows({ link, server: { getMembership: async () => membership() } })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)
        expect(signCalls).toBe(1)

        // A glance at another tab and back: UserScreen unmounts and remounts, but the Harness
        // instance standing in for App - and the `running` state lifted into it - survives.
        await act(async () => {
            tree.update(<Harness flows={flows} showUser={false} />)
        })
        await act(async () => {
            tree.update(<Harness flows={flows} />)
        })

        const [button] = tree.root.findAllByProps({ testID: "run-register" }, { deep: false })
        expect(button.props.loading).toBe(true)

        // The Pressable Button renders internally gates a real press on its own loading/disabled
        // state, unlike the bare `onPress` prop a `findByProps` match would fire regardless.
        await press(tree, 0)
        expect(signCalls).toBe(1)

        await act(async () => {
            resolveSign(registrationSignResult)
            await flush()
        })
    })

    it("plays the register outcome's entrance the first time it appears, but not after a remount that lifts it back", async () => {
        const link = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)

        expect(tree.root.findByProps({ testID: "register-outcome" }).props.entering).toBe(true)

        // A glance at another tab and back: UserScreen unmounts and remounts, but the lifted
        // registerOutcome survives in the Harness standing in for App.
        await act(async () => {
            tree.update(<Harness flows={flows} showUser={false} />)
        })
        await act(async () => {
            tree.update(<Harness flows={flows} />)
        })

        expect(tree.root.findByProps({ testID: "register-outcome" }).props.entering).toBe(false)
    })

    it("offers Start over once neither Register nor Issue is available, and resets both outcomes", async () => {
        const link = createFakeLinkClient({
            "registration.sign": async () => registrationSignResult,
            "credential.issue": async () => {
                throw new Error("wallet unreachable")
            }
        })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)
        await act(async () => {
            await tree.root.findByProps({ testID: "run-issue" }).props.onPress()
        })

        // A failed issue leaves a registered subject with no next step - neither button is offered.
        expect(tree.root.findAllByProps({ testID: "run-register" }, { deep: false })).toHaveLength(0)
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
        expect(allText(tree)).toContain("wallet unreachable")

        const [startOver] = tree.root.findAllByProps({ testID: "start-over" }, { deep: false })
        await act(async () => {
            startOver.props.onPress()
        })

        // Back to the intro, with nothing of the failed run left on screen.
        expect(allText(tree)).toContain("Register a wallet")
        expect(tree.root.findAllByProps({ testID: "run-register" }, { deep: false })).toHaveLength(1)
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
        expect(tree.root.findAllByProps({ testID: "start-over" }, { deep: false })).toHaveLength(0)
        expect(allText(tree)).not.toContain("wallet unreachable")
    })

    it("says the paymaster paid, and folds its figures away, after a sponsored registration", async () => {
        const link = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
        const sponsorship = {
            sender: hex(20, "01"),
            senderBalanceBefore: "0",
            senderBalanceAfter: "0",
            userOpHash: hex(32, "02"),
            bundleTxHash: hex(32, "03"),
            actualGasCost: "1234567",
            paymaster: hex(20, "04"),
            paymasterDepositBefore: "1000000000000000000",
            paymasterDepositAfter: "998765432100000000"
        }
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa"), sponsorship })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Registered")
        expect(text).toContain("Gas paid by the Semaphore paymaster")
        // Every figure waits behind the outcome's own Disclosure.
        expect(text).not.toContain("Gas")
        expect(text).not.toContain(sponsorship.actualGasCost)

        await openDisclosure(tree, "register-outcome-details")
        const opened = allText(tree)
        expect(opened).toContain("Gas")
        expect(opened).toContain(sponsorship.actualGasCost)
        expect(opened).toContain("Bundle transaction")

        // The next action is revealed with the line that says why it is worth taking.
        expect(allText(tree)).toContain("Reusable later to prove identity privately.")
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(1)
    })

    it("says nothing about the paymaster for a registration it didn't sponsor", async () => {
        const link = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)

        expect(allText(tree)).not.toContain("Gas paid by the Semaphore paymaster")
        await openDisclosure(tree, "register-outcome-details")
        expect(allText(tree)).toContain("Transaction")
    })

    it("shows an existing registration as its own outcome, not as a registration, and still allows issuing", async () => {
        const link = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({
                    status: "alreadyRegistered",
                    metaStealthAddress,
                    matchesRequest: true
                })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Already registered")
        expect(text).toContain("Matches this device")
        expect(text).toContain("Not counted twice")
        expect(text).not.toContain("Registered")
        expect(text).not.toContain("Gas paid by the Semaphore paymaster")
        // The network ID waits behind the outcome's own Disclosure.
        expect(text.some((line) => line.startsWith(networkId.slice(0, 6)))).toBe(false)

        await openDisclosure(tree, "register-outcome-details")
        expect(allText(tree).some((line) => line.startsWith(networkId.slice(0, 6)))).toBe(true)

        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(1)
    })

    it("refuses to issue against a record held under another device's stealth address", async () => {
        const link = createFakeLinkClient({ "registration.sign": async () => registrationSignResult })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({
                    status: "alreadyRegistered",
                    metaStealthAddress: hex(66, "ff"),
                    matchesRequest: false
                })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Different device")
        expect(text).not.toContain("Matches this device")
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
    })

    it("issues a credential and lifts the outcome up through onIssueOutcome", async () => {
        const onIssueOutcome = jest.fn()
        const link = createFakeLinkClient({
            "registration.sign": async () => registrationSignResult,
            "credential.issue": async () => ({ status: "stored", credentialId: "urn:uuid:cred-1" })
        })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} onIssueOutcome={onIssueOutcome} />)
        await flush()
        await press(tree, 0)
        await act(async () => {
            await tree.root.findByProps({ testID: "run-issue" }).props.onPress()
        })

        const text = allText(tree)
        expect(text).toContain("Credential issued")
        expect(text).toContain("demo-programme · ZZZ")
        expect(text.some((line) => line.startsWith("urn:uu"))).toBe(false)

        // The credential id waits behind the outcome's own Disclosure.
        await openDisclosure(tree, "issue-outcome-details")
        expect(allText(tree).some((line) => line.startsWith("urn:uu"))).toBe(true)

        expect(onIssueOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ status: "issued", credentialId: "urn:uuid:cred-1" })
        )
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
    })

    it("says so when the wallet already holds one of this org's credentials", async () => {
        const link = createFakeLinkClient({
            "registration.sign": async () => registrationSignResult,
            "credential.issue": async () => ({ status: "alreadyHeld", credentialId: "urn:uuid:existing" })
        })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)
        await act(async () => {
            await tree.root.findByProps({ testID: "run-issue" }).props.onPress()
        })

        const text = allText(tree)
        expect(text).toContain("Already issued")
        expect(text).toContain("Not issued twice")
        expect(text).not.toContain("Credential issued")
        expect(tree.root.findAllByProps({ testID: "run-issue" }, { deep: false })).toHaveLength(0)
    })

    it("reads the issuer server's own refusal back as the reason", async () => {
        const link = createFakeLinkClient({
            "registration.sign": async () => registrationSignResult,
            "credential.issue": async () => ({
                status: "refused",
                code: "SUBJECT_MISMATCH",
                message: "the binding names another subject"
            })
        })
        const flows = buildFlows({
            link,
            server: {
                getMembership: async () => membership(),
                submitRegistration: async () => ({ status: "submitted", txHash: hex(32, "aa") })
            }
        })

        const tree = await renderScreen(<Harness flows={flows} />)
        await flush()
        await press(tree, 0)
        await act(async () => {
            await tree.root.findByProps({ testID: "run-issue" }).props.onPress()
        })

        const text = allText(tree)
        expect(text).toContain("Refused")
        expect(text).toContain("the binding names another subject")
    })
})
