import { useMemo } from "react"
import { Easing, useReducedMotion, withTiming } from "react-native-reanimated"
import type { EntryExitAnimationFunction } from "react-native-reanimated"

/** Ease-out, for anything entering. Reanimated's own built-ins are too weak to read as a curve. */
export const easing = Easing.bezier(0.23, 1, 0.32, 1)

export const durations = {
    /** A step icon changing state. */
    step: 180,
    /** One sheet body replacing another. */
    body: 200,
    /** A flow's result arriving. */
    outcome: 250
} as const

export interface Entrance {
    duration: number
    /** Start offset in dp. */
    translateY?: number
    /** Start scale; never 0 - nothing in the real world appears from nothing. Above 1 settles down
     *  into place instead of growing into it. */
    scale?: number
}

/** The entrances the apps share, so a screen never invents another. */
export const entrances = {
    step: { duration: durations.step, scale: 0.9 },
    body: { duration: durations.body, translateY: 8 },
    outcome: { duration: durations.outcome, translateY: 12, scale: 0.95 },
    /** A verdict, pressed on rather than faded up: it settles down from slightly too big, which is
     *  the one thing in either app that moves against the direction everything else enters from. */
    stamp: { duration: durations.outcome, scale: 1.06 }
} as const satisfies Record<string, Entrance>

/** An `Animated.View entering` value. Transform and opacity only, so it runs off the JS thread. */
export function entering({ duration, translateY = 0, scale = 1 }: Entrance): EntryExitAnimationFunction {
    return () => {
        "worklet"
        const timing = { duration, easing }
        return {
            initialValues: { opacity: 0, transform: [{ translateY }, { scale }] },
            animations: {
                opacity: withTiming(1, timing),
                transform: [{ translateY: withTiming(0, timing) }, { scale: withTiming(1, timing) }]
            }
        }
    }
}

/** `entering`, dropping the movement when the system asks for less motion. The fade stays: it is
 *  what says something arrived. */
export function useEntering(entrance: Entrance): EntryExitAnimationFunction {
    const reduced = useReducedMotion()
    const { duration, translateY, scale } = entrance
    return useMemo(
        () => entering(reduced ? { duration } : { duration, translateY, scale }),
        [reduced, duration, translateY, scale]
    )
}
