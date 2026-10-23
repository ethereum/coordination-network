import { act } from "react-test-renderer"
import { useState } from "react"
import { Button } from "@coordination-network/app-ui"
import { View } from "react-native"
import jsQR from "jsqr"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import { decodePresentationQr } from "@coordination-network/user-app-link"
import {
    MemberServerError,
    type MemberServerClient,
    type PresentationStatus
} from "@coordination-network/network-member-app-core"
import CrossDeviceVerify from "../../src/screens/CrossDeviceVerify"
import { buildFlows, hex } from "../support"
import { useCrossDeviceVerification } from "../../src/use-cross-device-verification"
import type { MemberFlows } from "@coordination-network/network-member-app-core"

function HostedCheck({ flows }: { flows: MemberFlows }) {
    const verification = useCrossDeviceVerification(flows)
    return <CrossDeviceVerify verification={verification} programme="demo-programme" country="ZZZ" onBack={jest.fn()} />
}

const request = () => ({
    requestId: "urn:uuid:req",
    challenge: hex(31, "aa"),
    audience: hex(32, "a1"),
    currentTime: Math.floor(Date.now() / 1000),
    programme: "demo-programme",
    country: "ZZZ",
    expiresAt: Math.floor(Date.now() / 1000) + 300
})
const verdict = (ok = true) => ({
    verificationId: "urn:uuid:result",
    ok,
    ...(ok ? {} : { code: "PROOF_INVALID" }),
    requestId: "urn:uuid:req",
    audience: hex(32, "a1"),
    currentTime: request().currentTime,
    programme: "demo-programme",
    country: "ZZZ",
    challenge: hex(31, "aa"),
    verifiedAt: request().currentTime
})

async function setup(server: Partial<MemberServerClient> = {}) {
    const flows = buildFlows({
        server: {
            createPresentationRequest: async () => request(),
            getPresentationStatus: async () => ({ status: "pending" }),
            cancelPresentationRequest: async () => 200,
            ...server
        }
    })
    const tree = await renderScreen(<HostedCheck flows={flows} />)
    const click = async (testID: string) =>
        act(async () => {
            tree.root.findByProps({ testID }).props.onPress()
        })
    await click("create-presentation-qr")
    return { tree, click }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

it("renders a QR that an independent decoder reads from the actual native View geometry", async () => {
    const { tree } = await setup()
    const qr = tree.root.findByProps({ testID: "presentation-qr" })
    const width = qr.props.style.width
    const rgba = new Uint8ClampedArray(width * width * 4).fill(255)
    for (const view of qr.findAllByType(View)) {
        const style = view.props.style
        if (style?.backgroundColor !== "black") continue
        for (let y = Math.round(style.top); y < Math.round(style.top + style.height); y++) {
            for (let x = Math.round(style.left); x < Math.round(style.left + style.width); x++) {
                const offset = (y * width + x) * 4
                rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0
            }
        }
    }
    const decoded = jsQR(rgba, width, width)
    expect(decoded).not.toBeNull()
    const payload = decodePresentationQr(decoded!.data)
    expect(payload.params.requestId).toBe("urn:uuid:req")
    expect(payload.params.responseUrl).toBe("http://192.168.1.50:4001/v1/verify")
    expect(JSON.stringify(payload)).not.toContain("member-token")
    expect(allText(tree)).toContain("Waiting for the verifier server…")
    await act(async () => tree.unmount())
})

it.each([true, false])("shows only the authenticated server's verdict (accepted=%s)", async (ok) => {
    const status = jest
        .fn<Promise<PresentationStatus>, [string]>()
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValue({ status: "completed", verification: verdict(ok) })
    const { tree } = await setup({ getPresentationStatus: status })
    expect(allText(tree)).not.toContain("Eligible")
    await act(async () => {
        jest.advanceTimersByTime(1500)
    })
    expect(allText(tree)).toContain(ok ? "Eligible" : "Not eligible")
    expect(tree.root.findAllByProps({ testID: "presentation-qr" })).toHaveLength(0)
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => {
        jest.advanceTimersByTime(10000)
    })
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => tree.unmount())
})

it.each(["expired", "cancelled"] as const)("stops polling when the server reports %s", async (status) => {
    const poll = jest.fn<Promise<PresentationStatus>, [string]>().mockResolvedValue({ status })
    const { tree } = await setup({ getPresentationStatus: poll })
    expect(allText(tree)).toContain(status === "expired" ? "Request expired. Start a new check." : "Request cancelled.")
    await act(async () => {
        jest.advanceTimersByTime(10000)
    })
    expect(poll).toHaveBeenCalledTimes(1)
    await act(async () => tree.unmount())
})

it("recovers a lost response by polling the same request without generating another challenge", async () => {
    const create = jest.fn(async () => request())
    const status = jest
        .fn<Promise<PresentationStatus>, [string]>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ status: "completed", verification: verdict() })
    const { tree, click } = await setup({ createPresentationRequest: create, getPresentationStatus: status })
    expect(allText(tree)).toContain("Could not confirm the result. Check your connection, then retry status.")
    expect(allText(tree)).not.toContain("Eligible")
    await click("retry-presentation-status")
    expect(allText(tree)).toContain("Eligible")
    expect(create).toHaveBeenCalledTimes(1)
    expect(status.mock.calls).toEqual([["urn:uuid:req"], ["urn:uuid:req"]])
    await act(async () => tree.unmount())
})

it("rejects a mismatched request result instead of displaying success", async () => {
    const { tree } = await setup({
        getPresentationStatus: async () => ({ status: "completed", verification: { ...verdict(), requestId: "other" } })
    })
    expect(allText(tree)).not.toContain("Eligible")
    expect(allText(tree)).toContain("Could not confirm the result. Check your connection, then retry status.")
    await act(async () => tree.unmount())
})

it("cancellation prevents an in-flight response from changing the UI to success", async () => {
    let resolve!: (status: PresentationStatus) => void
    const cancel = jest.fn(async () => 200 as const)
    const { tree, click } = await setup({
        getPresentationStatus: () =>
            new Promise((answer) => {
                resolve = answer
            }),
        cancelPresentationRequest: cancel
    })
    await click("cancel-presentation")
    await act(async () => {
        resolve({ status: "completed", verification: verdict() })
    })
    expect(allText(tree)).not.toContain("Eligible")
    expect(cancel).toHaveBeenCalledWith("urn:uuid:req")
    await act(async () => tree.unmount())
})

it("leaving while challenge creation is in flight cancels the late request", async () => {
    let resolve!: (value: ReturnType<typeof request>) => void
    const cancel = jest.fn(async () => 200 as const)
    const { tree } = await setup({
        createPresentationRequest: () =>
            new Promise((answer) => {
                resolve = answer
            }),
        cancelPresentationRequest: cancel
    })
    await act(async () => tree.unmount())
    await act(async () => {
        resolve(request())
    })
    expect(cancel).toHaveBeenCalledWith("urn:uuid:req")
})

it("times out a silent status connection without falsely accepting the presentation", async () => {
    const { tree } = await setup({ getPresentationStatus: () => new Promise(() => undefined) })
    await act(async () => {
        jest.advanceTimersByTime(10000)
    })
    expect(allText(tree)).toContain("Could not confirm the result. Check your connection, then retry status.")
    expect(allText(tree)).not.toContain("Eligible")
    await act(async () => tree.unmount())
})

it("offers a new check when a server restart lost the request", async () => {
    const { tree } = await setup({
        getPresentationStatus: async () => {
            throw new MemberServerError("NOT_FOUND", "unknown request", 404)
        }
    })
    expect(allText(tree)).toContain("Request is no longer available. Start a new check.")
    expect(tree.root.findAllByProps({ testID: "retry-presentation-status" })).toHaveLength(0)
    await act(async () => tree.unmount())
})

it.each(["REVOCATION_ROOT_INVALID", "CREDENTIAL_REVOKED", "NO_CREDENTIAL", "ISSUER_ROOT_MISMATCH"])(
    "uses the same readable message for %s as same-phone verification",
    async (code) => {
        const { tree } = await setup({
            getPresentationStatus: async () => ({ status: "completed", verification: { ...verdict(false), code } })
        })
        expect(allText(tree)).toContain(
            code === "NO_CREDENTIAL"
                ? "No matching credential"
                : code === "ISSUER_ROOT_MISMATCH"
                  ? "Issuer list out of date"
                  : "Credential revoked"
        )
        expect(allText(tree)).not.toContain(code)
        await act(async () => tree.unmount())
    }
)

it("keeps polling when cancellation returns 409 and the server is still recording the result", async () => {
    let submitted = false
    const { tree, click } = await setup({
        getPresentationStatus: async () =>
            submitted ? { status: "completed", verification: verdict() } : { status: "pending" },
        cancelPresentationRequest: jest.fn(async () => {
            submitted = true
            return 409 as const
        })
    })
    await click("cancel-presentation")
    await act(async () => {
        jest.advanceTimersByTime(1500)
    })
    expect(allText(tree)).toContain("Eligible")
    expect(tree.root.findAllByProps({ testID: "cross-device-terminal" })).toHaveLength(0)
    await act(async () => tree.unmount())
})

it("keeps the displayed scope tied to the existing QR when the next check's settings change", async () => {
    const flows = buildFlows({ server: { createPresentationRequest: async () => request() } })
    function HostedScope() {
        const verification = useCrossDeviceVerification(flows)
        const [programme, setProgramme] = useState("demo-programme")
        return (
            <>
                <CrossDeviceVerify verification={verification} programme={programme} country="ZZZ" onBack={jest.fn()} />
                <Button
                    testID="change-scope"
                    label="Change next scope"
                    onPress={() => setProgramme("different-programme")}
                />
            </>
        )
    }
    const tree = await renderScreen(<HostedScope />)
    await act(async () => {
        tree.root.findByProps({ testID: "create-presentation-qr" }).props.onPress()
    })
    await act(async () => {
        tree.root.findByProps({ testID: "change-scope" }).props.onPress()
    })
    expect(allText(tree)).toContain("demo-programme · ZZZ")
    expect(allText(tree)).not.toContain("different-programme · ZZZ")
    await act(async () => tree.unmount())
})
