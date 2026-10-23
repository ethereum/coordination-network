import { LinkError } from "@coordination-network/user-app-link"
import type { FlowName, MemberHooks } from "../business"
import type { Failed, FlowError } from "../outcomes"
import { MemberServerError } from "../server/errors"

/** Normalizes whatever a flow catches - a LinkError, a MemberServerError, or an unexpected throw - into a plain value. */
export function toFlowError(error: unknown): FlowError {
    if (error instanceof LinkError || error instanceof MemberServerError) {
        return { message: error.message, code: error.code }
    }
    if (error instanceof Error) {
        return { message: error.message }
    }
    return { message: String(error) }
}

/** A hook that throws must never fail the flow it's attached to, or the onError report of an earlier failure. */
async function safeInvoke(hook: (() => unknown) | undefined): Promise<void> {
    if (!hook) return
    try {
        await hook()
    } catch {
        // Nowhere further to report this - see the comment above.
    }
}

/** Runs one of `MemberHooks`' success hooks, routing a throw to `onError` instead of letting it escape. */
export async function runHook(
    hooks: MemberHooks | undefined,
    flow: FlowName,
    stage: string,
    hook: (() => unknown) | undefined
): Promise<void> {
    if (!hook) return
    try {
        await hook()
    } catch (error) {
        await safeInvoke(() => hooks?.onError?.({ flow, stage, error }))
    }
}

/** Builds a flow's `failed` outcome, reporting it to `onError` on the way. */
export async function failed<Stage extends string>(
    hooks: MemberHooks | undefined,
    flow: FlowName,
    stage: Stage,
    error: unknown
): Promise<Failed<Stage>> {
    await safeInvoke(() => hooks?.onError?.({ flow, stage, error }))
    return { status: "failed", stage, error: toFlowError(error) }
}
