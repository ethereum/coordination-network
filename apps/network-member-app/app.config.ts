import type { ExpoConfig } from "expo/config"

/**
 * One codebase, two installable members. The deep-link scheme doubles as the member id, because
 * the user app shows the caller's scheme on its consent screen and a member has to be recognisable
 * there. Both instances must differ in Android package id or the second install replaces the first.
 */
// Mirrors `src/business/branding.ts`'s own maps - kept separate since this file runs in Node at
// build time, outside the app bundle `branding.ts` and its RN imports are meant for.
const DISPLAY_NAME: Record<string, string> = { "member-a": "Member A", "member-b": "Member B" }
const SPLASH_COLOR: Record<string, string> = { "member-a": "#1d4ed8", "member-b": "#f5b400" }

// No default, for the same reason `src/config.ts` has none: a default here names the package and
// the scheme after one member while the bundle may be inlined for the other, and the two halves of
// one install then disagree about which org it is.
const memberId = process.env.EXPO_PUBLIC_MEMBER_ID
if (memberId === undefined || !(memberId in DISPLAY_NAME)) {
    throw new Error(
        `EXPO_PUBLIC_MEMBER_ID must be one of ${Object.keys(DISPLAY_NAME).join(", ")} to configure this app, got ${memberId === undefined ? "nothing" : `"${memberId}"`}`
    )
}

const config: ExpoConfig = {
    name: DISPLAY_NAME[memberId],
    slug: `coordination-${memberId}`,
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    scheme: memberId,
    // This org's accent, so the launch is already telling the audience which app this is. Same
    // value as `src/business/branding.ts`'s `brand.accent`, which paints the band above every screen.
    splash: { backgroundColor: SPLASH_COLOR[memberId] },
    android: { package: `network.coordination.${memberId.replace(/-/g, "")}` },
    plugins: ["expo-dev-client", "expo-camera", "expo-font"]
}

export default config
