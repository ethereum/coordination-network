import { Feather } from "@expo/vector-icons"
import glyphs from "@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Feather.json"
import { renderScreen } from "@coordination-network/app-ui/testing"
import Icon from "../src/components/Icon"
import type { IconName } from "../src/components/Icon"

describe("Icon", () => {
    it("renders a Feather glyph with the given name", async () => {
        const tree = await renderScreen(<Icon name="shield" />)

        const feather = tree.root.findByType(Feather)
        expect(feather.props.name).toBe("shield")
    })

    it("defaults to size 20 and the ink colour", async () => {
        const tree = await renderScreen(<Icon name="shield" />)

        const feather = tree.root.findByType(Feather)
        expect(feather.props.size).toBe(20)
        expect(feather.props.color).toBe("#17201c")
    })

    it.each<IconName>(["check-circle", "x-circle", "user-plus", "zap", "eye-off", "lock", "arrow-right", "users"])(
        "resolves %s to a real Feather glyph",
        async (name) => {
            const tree = await renderScreen(<Icon name={name} />)

            const feather = tree.root.findByType(Feather)
            expect(feather.props.name).toBe(name)
            expect(glyphs).toHaveProperty(name)
        }
    )

    it("accepts a custom size and colour", async () => {
        const tree = await renderScreen(<Icon name="shield" size={32} color="#3355ff" />)

        const feather = tree.root.findByType(Feather)
        expect(feather.props.size).toBe(32)
        expect(feather.props.color).toBe("#3355ff")
    })
})
