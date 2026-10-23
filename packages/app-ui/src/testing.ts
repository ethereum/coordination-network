import type { ElementType, ReactElement } from "react"
import { act, create } from "react-test-renderer"
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer"
import { Pressable, Text, TextInput } from "react-native"

/** Every `Text` node's rendered content, for substring assertions against a screen's output. */
export function allText(tree: ReactTestRenderer): string[] {
    return tree.root.findAllByType(Text).map((node) => {
        const children = node.props.children
        return Array.isArray(children) ? children.join("") : String(children ?? "")
    })
}

/**
 * `create()` must run inside `act()` too, not just later state updates - otherwise React defers
 * part of the initial mount past `create`'s return and `.root` throws on the still-settling tree.
 */
export async function renderScreen(element: ReactElement): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer
    await act(async () => {
        tree = create(element)
    })
    return tree
}

/**
 * RN's `Pressable` is exported as `React.memo(PressableImpl)`; react-test-renderer resolves a
 * memoized fiber's `type` to that inner render function, not the memo wrapper - so lookups below
 * match against `.type` rather than the `Pressable` import itself.
 */
const PRESSABLE_TYPE = (Pressable as unknown as { type: ElementType }).type

/** Every `Pressable` in a rendered tree, in render order. */
export function findPressables(tree: ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType(PRESSABLE_TYPE)
}

/** Presses the `Pressable` at `index` (default: the first, for a screen with only one) and awaits its `onPress`. */
export async function press(tree: ReactTestRenderer, index = 0): Promise<void> {
    const pressable = findPressables(tree)[index]
    await act(async () => {
        await pressable.props.onPress()
    })
}

/** Every `TextInput` in a rendered tree, in render order - unlike `Pressable`, RN exports this one unmemoized. */
export function findTextInputs(tree: ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType(TextInput)
}

/** Types into the `TextInput` at `index` by calling its controlled `onChangeText`. */
export async function changeText(tree: ReactTestRenderer, index: number, text: string): Promise<void> {
    const input = findTextInputs(tree)[index]
    await act(async () => {
        input.props.onChangeText?.(text)
    })
}
