import * as Linking from "expo-linking"
import { createLinkClient } from "@coordination-network/user-app-link"
import type { LinkClient } from "@coordination-network/user-app-link"
import { memberId } from "./config"

/**
 * `caller.scheme` is this app's own scheme, which `app.config.ts` also sets to `memberId`, so the
 * user app's consent screen names the app a person just installed.
 *
 * It is not the scheme the request is sent to. That is `LinkClientOptions.scheme`, left unset here
 * so it defaults to `userapp` - the user app's. Setting it to this app's scheme would address every
 * request back at ourselves.
 */
export function createMemberLinkClient(callerName: string): LinkClient {
    return createLinkClient({
        caller: { name: callerName, scheme: memberId },
        callback: Linking.createURL("v1/response"),
        openUrl: async (url) => {
            await Linking.openURL(url)
        },
        onUrl: (listener) => {
            const subscription = Linking.addEventListener("url", ({ url }) => listener(url))
            return () => subscription.remove()
        }
    })
}
