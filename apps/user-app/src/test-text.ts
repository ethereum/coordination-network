import type { ReactTestRenderer, ReactTestRendererJSON } from "react-test-renderer"

type Node = ReactTestRendererJSON | string

function join(node: Node): string {
    return typeof node === "string" ? node : (node.children ?? []).map(join).join("")
}

/**
 * Everything a rendered tree says, concatenated in render order. `allText` reads one `Text` node's
 * own children, which turns a sentence naming an org mid-line into `…with [object Object] to…`;
 * this reads the rendered output, so such a sentence comes back whole. Lives outside `__tests__`
 * because jest treats every file under that directory as a suite of its own.
 */
export function renderedText(tree: ReactTestRenderer): string {
    const root = tree.toJSON()
    if (root === null) return ""
    return (Array.isArray(root) ? root : [root]).map(join).join("")
}
