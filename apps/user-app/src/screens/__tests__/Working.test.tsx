import { LINK_OPS } from "@coordination-network/user-app-link"
import type { LinkOp } from "@coordination-network/user-app-link"
import { allText, renderScreen } from "@coordination-network/app-ui/testing"
import Working from "../Working"

const OP_LABELS: Record<LinkOp, string> = {
    "registration.sign": "Sharing your identity",
    "credential.issue": "Storing a credential",
    "presentation.create": "Proving"
}

describe("Working", () => {
    it.each(LINK_OPS)("names what it is doing for %s, and asks for the one thing it needs", async (op) => {
        const tree = await renderScreen(<Working op={op} step={null} />)

        const text = allText(tree)
        expect(text).toContain(OP_LABELS[op])
        expect(text).toContain("Keep this app open.")
    })

    it("lists an issuance's three steps, the reported one running and the rest waiting", async () => {
        const tree = await renderScreen(<Working op="credential.issue" step="Binding to this phone" />)

        const text = allText(tree)
        expect(text).toContain("Checking your credential status")
        expect(text).toContain("Binding the credential")
        expect(text).toContain("Storing the credential")
        expect(tree.root.findAllByProps({ testID: "step-binding-spinner" }).length).toBeGreaterThan(0)
    })

    it("moves the spinner on as the handler reports its next step", async () => {
        const tree = await renderScreen(<Working op="presentation.create" step="Proving" />)

        expect(tree.root.findAllByProps({ testID: "step-proving-spinner" }).length).toBeGreaterThan(0)
        expect(tree.root.findAllByProps({ testID: "step-checking-spinner" })).toHaveLength(0)
    })

    it("keeps a registration to its label: there is no progress to report inside one signature", async () => {
        const tree = await renderScreen(<Working op="registration.sign" step={null} />)

        // The op's icon is a `Feather` glyph, a private-use codepoint in a `Text` of its own.
        const words = allText(tree).filter((line) => /\w/.test(line))
        expect(words).toEqual(["Sharing your identity", "Keep this app open."])
    })

    it("counts nothing: a clock measures the wait without shortening it", async () => {
        const tree = await renderScreen(<Working op="presentation.create" step="Proving" />)

        expect(allText(tree).some((line) => /^\d+s$/.test(line))).toBe(false)
    })
})
