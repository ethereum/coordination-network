import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import { act } from "react-test-renderer"
import { Linking } from "react-native"
import type { MembershipStatusResponse } from "@coordination-network/network-member-app-core"
import { business } from "../../src/business"
import SettingsScreen from "../../src/screens/Settings"
import { buildFlows, hex, openDisclosure } from "../support"

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
        safe: { address: hex(20, "cc"), threshold: 2, owners: [hex(20, "bb"), hex(20, "dd")] },
        identityRegistered: true,
        issuerKeyPublished: true,
        ...overrides
    }
}

const config = {
    networkId: hex(32, "11"),
    displayName: "Member A",
    serverUrl: "http://192.168.1.50:4001",
    registry: { chainId: 31337, verifyingContract: hex(20, "10") },
    memberServerToken: "member-token-a"
}

describe("SettingsScreen", () => {
    afterEach(() => {
        jest.restoreAllMocks()
    })

    it("shows the identity card", async () => {
        const flows = buildFlows({ config, server: { getMembership: async () => membership() } })

        const tree = await renderScreen(
            <SettingsScreen
                flows={flows}
                config={config}
                role="founder"
                dashboardUrl="http://192.168.1.50:8080"
                onChangeStack={jest.fn()}
            />
        )
        await flush()

        const text = allText(tree)
        expect(text).toContain(business.branding.displayName)
        expect(text).toContain("Founding org")
        // The network ID waits behind the Disclosure - only its label shows up front.
        expect(text).not.toContain("Network ID")

        await openDisclosure(tree, "settings-network-id")
        expect(allText(tree)).toContain("Network ID")
    })

    it("shows the candidate role badge for a candidate member", async () => {
        const flows = buildFlows({ config, server: { getMembership: async () => membership() } })

        const tree = await renderScreen(
            <SettingsScreen
                flows={flows}
                config={config}
                role="candidate"
                dashboardUrl="http://192.168.1.50:8080"
                onChangeStack={jest.fn()}
            />
        )
        await flush()

        const text = allText(tree)
        expect(text).toContain("Candidate")
        expect(text).not.toContain("Founding org")
    })

    it("folds the Safe rows away behind the membership badge", async () => {
        const flows = buildFlows({
            config,
            server: { getMembership: async () => membership({ status: "requested", identityRegistered: false }) }
        })

        const tree = await renderScreen(
            <SettingsScreen
                flows={flows}
                config={config}
                role="candidate"
                dashboardUrl="http://192.168.1.50:8080"
                onChangeStack={jest.fn()}
            />
        )
        await flush()

        expect(allText(tree)).toContain("Requested")
        expect(allText(tree)).not.toContain("Threshold")

        await openDisclosure(tree, "settings-membership-details")
        const opened = allText(tree)
        expect(opened).toContain("Threshold")
        expect(opened).toContain("2 of 2")
        expect(opened.some((line) => line === "No" || line === "Yes")).toBe(true)
    })

    it("says it couldn't check, and why, when the check fails", async () => {
        const flows = buildFlows({
            config,
            server: {
                getMembership: async () => {
                    throw new Error("network down")
                }
            }
        })

        const tree = await renderScreen(
            <SettingsScreen
                flows={flows}
                config={config}
                role="founder"
                dashboardUrl="http://192.168.1.50:8080"
                onChangeStack={jest.fn()}
            />
        )
        await flush()

        const text = allText(tree)
        expect(text).toContain("Unable to check")
        expect(text).toContain("network down")
    })

    it("opens the status page and the dashboard through Linking.openURL", async () => {
        const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true)
        const flows = buildFlows({ config, server: { getMembership: async () => membership() } })

        const tree = await renderScreen(
            <SettingsScreen
                flows={flows}
                config={config}
                role="founder"
                dashboardUrl="http://192.168.1.50:8080"
                onChangeStack={jest.fn()}
            />
        )
        await flush()

        await act(async () => {
            await tree.root.findByProps({ testID: "open-status-page" }).props.onPress()
        })
        await act(async () => {
            await tree.root.findByProps({ testID: "open-dashboard" }).props.onPress()
        })

        expect(openURL).toHaveBeenNthCalledWith(1, config.serverUrl)
        expect(openURL).toHaveBeenNthCalledWith(2, "http://192.168.1.50:8080")
    })

    it("calls onChangeStack from its button", async () => {
        const onChangeStack = jest.fn()
        const flows = buildFlows({ config, server: { getMembership: async () => membership() } })

        const tree = await renderScreen(
            <SettingsScreen
                flows={flows}
                config={config}
                role="founder"
                dashboardUrl="http://192.168.1.50:8080"
                onChangeStack={onChangeStack}
            />
        )
        await flush()

        await act(async () => {
            tree.root.findByProps({ testID: "change-stack" }).props.onPress()
        })

        expect(onChangeStack).toHaveBeenCalledTimes(1)
    })
})
