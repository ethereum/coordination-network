import { describe, expect, it } from "@jest/globals"
import { useState } from "react"
import type { JSX } from "react"
import { LinkError } from "@coordination-network/user-app-link"
import { allText, press, renderScreen } from "@coordination-network/app-ui/testing"
import { act } from "react-test-renderer"
import type {
    MemberFlows,
    VerificationResponse,
    VerifyOutcome,
    VerifyStage
} from "@coordination-network/network-member-app-core"
import { APPROVAL_SCOPE } from "../../src/business"
import VerifyScreen from "../../src/screens/Verify"
import { useCrossDeviceVerification } from "../../src/use-cross-device-verification"
import type { BuildFlowsOptions } from "../support"
import { buildFlows, createFakeLinkClient, hex, openDisclosure } from "../support"

const presentationRequest = {
    requestId: "urn:uuid:req-1",
    challenge: hex(31, "9c"),
    audience: "urn:cn:network:member-server",
    currentTime: 1_700_000_000,
    programme: "demo-programme",
    country: "ZZZ",
    expiresAt: 1_700_000_300
}

function verification(overrides: Partial<VerificationResponse> = {}): VerificationResponse {
    return {
        verificationId: "urn:uuid:verification-1",
        ok: true,
        requestId: presentationRequest.requestId,
        audience: presentationRequest.audience,
        currentTime: presentationRequest.currentTime,
        challenge: presentationRequest.challenge,
        programme: presentationRequest.programme,
        country: presentationRequest.country,
        verifiedAt: 1_700_000_100,
        ...overrides
    }
}

/** The state App owns, held here instead, so these tests drive the screen the way the app does. */
function HostedVerify({ flows }: { flows: MemberFlows }): JSX.Element {
    const crossDevice = useCrossDeviceVerification(flows)
    const [programme, setProgramme] = useState(APPROVAL_SCOPE.programme)
    const [country, setCountry] = useState(APPROVAL_SCOPE.country)
    const [stage, setStage] = useState<VerifyStage | null>(null)
    const [outcome, setOutcome] = useState<VerifyOutcome | null>(null)

    return (
        <VerifyScreen
            flows={flows}
            crossDevice={crossDevice}
            programme={programme}
            onProgrammeChange={setProgramme}
            country={country}
            onCountryChange={setCountry}
            stage={stage}
            onStageChange={setStage}
            outcome={outcome}
            onOutcomeChange={setOutcome}
        />
    )
}

function flowsFor({ server, link }: BuildFlowsOptions = {}) {
    return buildFlows({
        server: { createPresentationRequest: async () => presentationRequest, ...server },
        link:
            link ??
            createFakeLinkClient({
                "presentation.create": async () => ({ verificationId: "urn:uuid:verification-1" })
            })
    })
}

describe("VerifyScreen", () => {
    it("opens on the checklist, with the scope behind the disclosure and no result yet", async () => {
        const tree = await renderScreen(<HostedVerify flows={buildFlows()} />)

        const text = allText(tree)
        expect(text).toContain("Check eligibility")
        expect(text).toContain("Holds a valid credential")
        expect(text).toContain("demo-programme")
        expect(text).toContain("Country ZZZ")
        expect(text).toContain("Check")
        expect(text).not.toContain("Eligible")

        // The programme and country are editable, but only for someone who goes looking.
        expect(tree.root.findAllByProps({ testID: "verify-programme" }, { deep: false })).toHaveLength(0)
        await openDisclosure(tree, "verify-settings")
        expect(tree.root.findAllByProps({ testID: "verify-programme" }, { deep: false })).toHaveLength(1)
        expect(tree.root.findAllByProps({ testID: "verify-country" }, { deep: false })).toHaveLength(1)
    })

    it("bounds the programme and country inputs to the wallet's own schema limits", async () => {
        const tree = await renderScreen(<HostedVerify flows={buildFlows()} />)

        await openDisclosure(tree, "verify-settings")

        expect(tree.root.findByProps({ testID: "verify-programme" }).props.maxLength).toBe(64)
        expect(tree.root.findByProps({ testID: "verify-country" }).props.maxLength).toBe(3)
    })

    it("steps from asking the wallet to checking the proof as the flow reports its stages", async () => {
        let answerWallet!: (value: { verificationId: string }) => void
        const flows = flowsFor({
            server: { getVerification: async () => verification() },
            link: createFakeLinkClient({
                "presentation.create": () =>
                    new Promise((resolve) => {
                        answerWallet = resolve
                    })
            })
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await act(async () => {
            void tree.root.findByProps({ testID: "run-verify" }).props.onPress()
        })

        // Waiting on the wallet: the first step spins, the second hasn't started.
        expect(allText(tree)).toContain("Asking the wallet")
        expect(tree.root.findAllByProps({ testID: "step-ask-spinner" }, { deep: false })).toHaveLength(1)
        expect(tree.root.findAllByProps({ testID: "step-check-spinner" }, { deep: false })).toHaveLength(0)

        await act(async () => {
            answerWallet({ verificationId: "urn:uuid:verification-1" })
        })

        expect(allText(tree)).toContain("Eligible")
    })

    it("says the person is eligible, naming the credential this org asked for", async () => {
        const flows = flowsFor({ server: { getVerification: async () => verification() } })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Eligible")
        expect(text).toContain("Valid demo-programme credential · ZZZ")
        // The verification id waits behind the Disclosure - nothing starting with its prefix shows yet.
        expect(text.some((line) => line.startsWith("urn:uu"))).toBe(false)

        await openDisclosure(tree, "verify-details")
        // `KeyValue` middle-truncates a value this long by default, so only its head survives.
        expect(allText(tree).some((line) => line.startsWith("urn:uu"))).toBe(true)
    })

    it("says an issuer this org doesn't approve is not eligible, and folds the code away", async () => {
        const flows = flowsFor({
            server: { getVerification: async () => verification({ ok: false, code: "ISSUER_ROOT_MISMATCH" }) }
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Not eligible")
        expect(text).toContain("Issuer list out of date")
        expect(text).not.toContain("ISSUER_ROOT_MISMATCH")

        await openDisclosure(tree, "verify-details")
        expect(allText(tree)).toContain("ISSUER_ROOT_MISMATCH")
    })

    it("says a credential this org's registry recorded as revoked is not eligible", async () => {
        const flows = flowsFor({
            server: { getVerification: async () => verification({ ok: false, code: "REVOCATION_ROOT_INVALID" }) }
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Not eligible")
        expect(text).toContain("Credential revoked")
    })

    it("reads a revoked credential the wallet refused to present", async () => {
        const flows = flowsFor({
            server: { closePresentationRequest: async () => ({ verificationId: "urn:uuid:verification-2" }) },
            link: createFakeLinkClient({
                "presentation.create": async () => {
                    throw new LinkError("CREDENTIAL_REVOKED")
                }
            })
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Not eligible")
        expect(text).toContain("Credential revoked")
    })

    it("reads a wallet that holds no matching credential", async () => {
        const flows = flowsFor({
            server: { closePresentationRequest: async () => ({ verificationId: "urn:uuid:verification-2" }) },
            link: createFakeLinkClient({
                "presentation.create": async () => {
                    throw new LinkError("NO_CREDENTIAL")
                }
            })
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        expect(allText(tree)).toContain("No matching credential")
    })

    it("reads a link timeout as a prompt to reopen the wallet", async () => {
        const flows = flowsFor({
            link: createFakeLinkClient({
                "presentation.create": async () => {
                    throw new Error("createLinkClient: request timed out after 120000ms")
                }
            })
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("Failed")
        expect(text).toContain("No answer from the wallet. Open it, then try again.")
    })

    it("shows a non-timeout failure's own message, with its stage folded away", async () => {
        const flows = flowsFor({
            link: createFakeLinkClient({
                "presentation.create": async () => {
                    throw new Error("link declined the request")
                }
            })
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        const text = allText(tree)
        expect(text).toContain("link declined the request")
        expect(text).not.toContain("No answer from the wallet. Open it, then try again.")

        await openDisclosure(tree, "verify-details")
        // `KeyValue` middle-truncates a value this long by default, so only its head survives.
        expect(allText(tree).some((line) => line.startsWith("presen"))).toBe(true)
    })

    // A verdict is this org's record of one presentation. Check would not re-read it - it would
    // open a whole new request - so it is replaced rather than left under the result to be tapped.
    it.each(["verified", "rejected"] as const)("stops offering Check once a %s verdict is in", async (status) => {
        const flows = flowsFor({
            server: {
                getVerification: async () => verification(status === "verified" ? {} : { ok: false, code: "NO_MATCH" })
            }
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        expect(tree.root.findAllByProps({ testID: "run-verify" }, { deep: false })).toHaveLength(1)

        await press(tree, 0)

        expect(tree.root.findAllByProps({ testID: "run-verify" }, { deep: false })).toHaveLength(0)
        expect(tree.root.findAllByProps({ testID: "check-again" }, { deep: false })).toHaveLength(1)
        expect(allText(tree)).toContain("Check again")
    })

    it("runs a fresh check from Check again, and shows the new verdict", async () => {
        let ok = true
        const flows = flowsFor({
            server: { getVerification: async () => verification(ok ? {} : { ok: false, code: "NO_CREDENTIAL" }) }
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)
        expect(allText(tree)).toContain("Eligible")

        ok = false
        await act(async () => {
            await tree.root.findByProps({ testID: "check-again" }).props.onPress()
        })

        expect(allText(tree)).toContain("Not eligible")
    })

    // Nothing was recorded, so this is the one outcome where the same button is still the answer.
    it("leaves Check in place after a failure, since trying again is the recovery", async () => {
        const flows = flowsFor({
            link: createFakeLinkClient({
                "presentation.create": async () => {
                    throw new Error("createLinkClient: request timed out after 120000ms")
                }
            })
        })

        const tree = await renderScreen(<HostedVerify flows={flows} />)
        await press(tree, 0)

        expect(allText(tree)).toContain("Failed")
        expect(tree.root.findAllByProps({ testID: "run-verify" }, { deep: false })).toHaveLength(1)
        expect(tree.root.findAllByProps({ testID: "check-again" }, { deep: false })).toHaveLength(0)
    })
})
