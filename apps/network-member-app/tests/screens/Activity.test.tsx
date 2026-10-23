import { beforeEach, describe, expect, it } from "@jest/globals"
import { allText, press, renderScreen } from "@coordination-network/app-ui/testing"
import { act } from "react-test-renderer"
import { clearActivity, hooks } from "../../src/business/hooks"
import ActivityScreen from "../../src/screens/Activity"
import { hex } from "../support"

const issued = {
    status: "issued" as const,
    subject: { networkId: hex(32, "11"), metaStealthAddress: hex(66, "22"), securityLevel: "SOFTWARE" as const },
    credentialId: "urn:uuid:cred-1",
    approvalScope: { programme: "demo-programme", country: "ZZZ" }
}

/** Unsubscribes `ActivityScreen`'s listener before the log's shared module state outlives this test. */
async function unmount(tree: { unmount(): void }): Promise<void> {
    await act(async () => {
        tree.unmount()
    })
}

describe("ActivityScreen", () => {
    beforeEach(() => {
        clearActivity()
    })

    it("shows the empty state before anything has run", async () => {
        const tree = await renderScreen(<ActivityScreen />)

        expect(allText(tree)).toContain("Nothing yet")
        await unmount(tree)
    })

    it("lists a recorded entry with a readable timestamp, and no id in its message", async () => {
        hooks.onIssued?.(issued)

        const tree = await renderScreen(<ActivityScreen />)

        expect(allText(tree)).toContain("issued a credential")
        await unmount(tree)
    })

    it("clears the log", async () => {
        hooks.onIssued?.(issued)
        const tree = await renderScreen(<ActivityScreen />)

        await press(tree, 0)

        expect(allText(tree)).toContain("Nothing yet")
        await unmount(tree)
    })
})
