import type { EntryExitAnimationFunction, LayoutAnimation } from "react-native-reanimated"
import { renderScreen } from "@coordination-network/app-ui/testing"
import { entering, entrances, useEntering } from "../src/motion"
import type { Entrance } from "../src/motion"

const mockReducedMotion = { on: false }

jest.mock("react-native-reanimated", () => ({
    ...jest.requireActual("react-native-reanimated"),
    useReducedMotion: () => mockReducedMotion.on
}))

function initialValuesOf(animation: EntryExitAnimationFunction): LayoutAnimation["initialValues"] {
    return (animation as () => LayoutAnimation)().initialValues
}

let captured: EntryExitAnimationFunction

function Probe({ entrance }: { entrance: Entrance }) {
    captured = useEntering(entrance)
    return null
}

describe("motion", () => {
    beforeEach(() => {
        mockReducedMotion.on = false
    })

    it("starts an entrance faded out and displaced", () => {
        expect(initialValuesOf(entering(entrances.outcome))).toEqual({
            opacity: 0,
            transform: [{ translateY: 12 }, { scale: 0.95 }]
        })
    })

    it("leaves out the axis an entrance does not use", () => {
        expect(initialValuesOf(entering(entrances.body))).toEqual({
            opacity: 0,
            transform: [{ translateY: 8 }, { scale: 1 }]
        })
        expect(initialValuesOf(entering(entrances.step))).toEqual({
            opacity: 0,
            transform: [{ translateY: 0 }, { scale: 0.9 }]
        })
    })

    it("keeps every entrance inside the 180 to 250 ms band", () => {
        for (const entrance of Object.values(entrances)) {
            expect(entrance.duration).toBeGreaterThanOrEqual(180)
            expect(entrance.duration).toBeLessThanOrEqual(250)
        }
    })

    it("drops the movement but keeps the fade when the system asks for less motion", async () => {
        mockReducedMotion.on = true
        await renderScreen(<Probe entrance={entrances.outcome} />)

        expect(initialValuesOf(captured)).toEqual({ opacity: 0, transform: [{ translateY: 0 }, { scale: 1 }] })
    })

    it("keeps the movement otherwise", async () => {
        await renderScreen(<Probe entrance={entrances.outcome} />)

        expect(initialValuesOf(captured)).toEqual({ opacity: 0, transform: [{ translateY: 12 }, { scale: 0.95 }] })
    })
})
