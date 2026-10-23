import * as Linking from "expo-linking"
import {
    createRequestHandler,
    LINK_OPS,
    type DecodedLinkRequest,
    type LinkHandlers,
    type LinkOp
} from "@coordination-network/user-app-link"

export interface LinkSubscriptionOptions {
    /** Do not let an incoming link dismiss a cross-device consent/proof already on screen. */
    isBusy?: () => boolean
    handlers: LinkHandlers
    consent: (request: DecodedLinkRequest) => Promise<boolean>
    /** Fires with the op once consent approves it, and with `null` once that request is done. */
    onWorking?: (op: LinkOp | null) => void
}

export interface LinkSubscription {
    remove(): void
}

let initialUrlConsumed = false

/** Test-only: the launch URL is read once per process, which outlives any one subscription. */
export function resetInitialUrlForTests(): void {
    initialUrlConsumed = false
}

function isLinkOp(op: string): op is LinkOp {
    return (LINK_OPS as readonly string[]).includes(op)
}

/**
 * Wires `createRequestHandler` to `expo-linking`: every incoming request URL becomes a response
 * URL opened back in the caller. `handler.handle` itself calls `consent` before dispatch, so a
 * second deep link arriving while the person is still looking at the first one's consent screen
 * must wait its turn rather than showing a second prompt on top of it — hence the queue below.
 */
export function createLinkSubscription(options: LinkSubscriptionOptions): LinkSubscription {
    // `request.op` is only known to be a `LinkOp` once `handler.handle` has already validated it,
    // which happens before this runs - `isLinkOp` here just re-attaches the type, not a runtime check.
    async function consentAndReportWorking(request: DecodedLinkRequest): Promise<boolean> {
        const approved = await options.consent(request)
        if (approved && isLinkOp(request.op)) options.onWorking?.(request.op)
        return approved
    }

    const handler = createRequestHandler({ handlers: options.handlers, consent: consentAndReportWorking })

    let queue: Promise<void> = Promise.resolve()
    let removed = false

    async function processUrl(url: string): Promise<void> {
        if (removed || options.isBusy?.()) return
        try {
            const responseUrl = await handler.handle(url)
            await Linking.openURL(responseUrl)
        } catch {
            // LinkDecodeError (no usable id/callback) or Linking.openURL rejecting because the
            // caller's callback scheme can't be opened: either way there is nowhere to respond.
        } finally {
            options.onWorking?.(null)
        }
    }

    function enqueue(url: string): void {
        queue = queue.then(() => processUrl(url))
    }

    const subscription = Linking.addEventListener("url", ({ url }) => enqueue(url))

    // `getInitialURL` keeps returning the URL that launched the app, so a subscription rebuilt
    // later - after an erase, or by a development double-mount - would answer that same request a
    // second time: two consent prompts, and for `issuance.bind` a second orphaned revocation
    // secret. Once per launch is the correct number.
    if (!initialUrlConsumed) {
        initialUrlConsumed = true
        void Linking.getInitialURL().then((url) => {
            if (url !== null) enqueue(url)
        })
    }

    return {
        remove: () => {
            removed = true
            subscription.remove()
        }
    }
}
