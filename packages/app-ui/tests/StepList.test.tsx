import { Text } from "react-native"
import { allText, press, renderScreen } from "@coordination-network/app-ui/testing"
import StepList from "../src/components/StepList"
import type { Step } from "../src/components/StepList"
import Icon from "../src/components/Icon"

const steps: Step[] = [
    { key: "identity", title: "Create identity", oneLiner: "Derives your keys.", state: "done" },
    { key: "register", title: "Register on chain", oneLiner: "Sponsored by the paymaster.", state: "running" },
    {
        key: "issue",
        title: "Issue credential",
        oneLiner: "Waiting on registration.",
        state: "idle",
        // Under KeyValue's 11-character truncation threshold, so the text shows whole.
        details: [{ label: "Programme", value: "demo-2026" }]
    },
    { key: "verify", title: "Verify", oneLiner: "Something went wrong.", state: "failed" }
]

function fontFamiliesOf(tree: Awaited<ReturnType<typeof renderScreen>>): (string | undefined)[] {
    return tree.root
        .findAll((node) => node.type === Text && typeof node.props.style === "object" && node.props.style !== null)
        .map((node) => (node.props.style as { fontFamily?: string }).fontFamily)
}

describe("StepList", () => {
    it("shows an icon for idle, done and failed steps and a spinner for the running one", async () => {
        const tree = await renderScreen(<StepList steps={steps} />)

        const icons = tree.root.findAllByType(Icon)
        expect(icons.map((icon) => icon.props.name)).toEqual(["check", "circle", "x"])
        expect(tree.root.findByProps({ testID: "step-register-spinner" })).toBeTruthy()
    })

    it("hides step details until the toggle is pressed", async () => {
        const tree = await renderScreen(<StepList steps={steps} />)

        expect(allText(tree)).not.toContain("demo-2026")

        await press(tree, 0)

        expect(allText(tree)).toContain("demo-2026")
    })

    it("renders a detail marked mono in the monospace face, and the others in the default face", async () => {
        const withHash: Step[] = [
            {
                key: "register",
                title: "Register",
                oneLiner: "Writes the record.",
                state: "done",
                details: [
                    { label: "Transaction", value: "0xabc123", mono: true },
                    { label: "Programme", value: "demo-2026" }
                ]
            }
        ]
        const tree = await renderScreen(<StepList steps={withHash} />)
        await press(tree, 0)

        const families = fontFamiliesOf(tree).filter((family) => family !== undefined)
        expect(families).toHaveLength(1)
    })

    it("marks an existing record with its own icon and ink, never the success check", async () => {
        const existing: Step[] = [{ key: "register", title: "Register on chain", state: "existing" }]
        const tree = await renderScreen(<StepList steps={existing} />)

        const [icon] = tree.root.findAllByType(Icon)
        expect(icon.props.name).toBe("users")
        expect(icon.props.color).toBe("#176b4d")
    })

    it("renders no second line for a step without a one-liner", async () => {
        const terse: Step[] = [{ key: "register", title: "Register on chain", state: "running" }]
        const tree = await renderScreen(<StepList steps={terse} />)

        // The number in the bullet, and the title.
        expect(tree.root.findAllByType(Text)).toHaveLength(2)
    })

    it("keeps the step's accessibility label readable without a one-liner", async () => {
        const terse: Step[] = [{ key: "register", title: "Register on chain", state: "done" }]
        const tree = await renderScreen(<StepList steps={terse} />)

        const [labelled] = tree.root.findAll((node) => typeof node.props.accessibilityLabel === "string")
        expect(labelled.props.accessibilityLabel).toBe("Step 1: Register on chain. done.")
    })

    it("shows details for a failed step too, once toggled", async () => {
        const failedWithDetails: Step[] = [
            {
                key: "verify",
                title: "Verify",
                oneLiner: "Something went wrong.",
                state: "failed",
                details: [{ label: "Reason", value: "mismatch" }]
            }
        ]
        const tree = await renderScreen(<StepList steps={failedWithDetails} />)

        expect(allText(tree)).not.toContain("mismatch")

        await press(tree, 0)

        expect(allText(tree)).toContain("mismatch")
    })
})
