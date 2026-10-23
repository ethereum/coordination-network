import { Text } from "react-native"
import { renderScreen } from "@coordination-network/app-ui/testing"
import EmptyState from "../src/components/EmptyState"
import Icon from "../src/components/Icon"

describe("EmptyState", () => {
    it("renders the title and body but no action when none is given", async () => {
        const tree = await renderScreen(<EmptyState title="No credentials yet" body="Issue one to see it here." />)

        expect(tree.root.findByProps({ children: "No credentials yet" })).toBeTruthy()
        expect(tree.root.findByProps({ children: "Issue one to see it here." })).toBeTruthy()
    })

    it("renders no body text when none is given", async () => {
        const tree = await renderScreen(<EmptyState title="No credentials yet" />)

        expect(tree.root.findByProps({ children: "No credentials yet" })).toBeTruthy()
        expect(tree.root.findAllByType(Text)).toHaveLength(1)
    })

    it("renders the action when given", async () => {
        const tree = await renderScreen(<EmptyState title="No credentials yet" action={<Text>Issue now</Text>} />)

        expect(tree.root.findByProps({ children: "Issue now" })).toBeTruthy()
    })

    it("renders no icon when none is given", async () => {
        const tree = await renderScreen(<EmptyState title="No credentials yet" />)

        expect(tree.root.findAllByType(Icon)).toHaveLength(0)
    })

    it("renders the icon above the title when given", async () => {
        const tree = await renderScreen(<EmptyState title="No credentials yet" icon="file-text" />)

        const icon = tree.root.findByType(Icon)
        expect(icon.props.name).toBe("file-text")
    })
})
