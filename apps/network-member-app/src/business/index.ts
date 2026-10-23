import type { MemberBusiness } from "@coordination-network/network-member-app-core"
import { branding } from "./branding"
import { hooks } from "./hooks"
import { policy } from "./policy"

export const business: MemberBusiness = { policy, hooks, branding }

export { brand } from "./branding"

export { APPROVAL_SCOPE } from "./policy"
export { clearActivity, subscribeToActivity } from "./hooks"
export type { ActivityEntry, ActivityTone } from "./hooks"
