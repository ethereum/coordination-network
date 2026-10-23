import { BRANDS } from "@coordination-network/app-ui"
import type { Brand, BrandKey } from "@coordination-network/app-ui"
import type { MemberBranding } from "@coordination-network/network-member-app-core"
import { memberId } from "../config"

// The same two strings `serve.ts` writes to stack.json, so the band, the dashboard and the
// wallet's consent sentence all call this org by one name.
const DISPLAY_NAME: Record<typeof memberId, string> = { "member-a": "Member A", "member-b": "Member B" }

const BRAND_KEY: Record<typeof memberId, BrandKey> = { "member-a": "blue", "member-b": "yellow" }

/**
 * This install's colours. Read from `BRANDS` rather than from the stack's own `brand`, because
 * Setup renders before any stack is loaded and the audience must already see whose app this is.
 * `app.config.ts` paints the splash this same accent; change one and change the other.
 */
export const brand: Brand = BRANDS[BRAND_KEY[memberId]]

export const branding: MemberBranding = {
    displayName: DISPLAY_NAME[memberId]
}
