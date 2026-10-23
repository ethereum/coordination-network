import { createContext, createElement, useContext } from "react"
import type { ReactNode } from "react"
import { Platform } from "react-native"

export interface TypeStyle {
    fontSize: number
    lineHeight: number
}

export const typeScale = {
    xs: { fontSize: 13, lineHeight: 18 },
    sm: { fontSize: 15, lineHeight: 20 },
    md: { fontSize: 17, lineHeight: 23 },
    lg: { fontSize: 22, lineHeight: 28 },
    xl: { fontSize: 28, lineHeight: 36 }
} as const satisfies Record<string, TypeStyle>

export const spacing = {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32
} as const

export const radii = {
    sm: 8,
    md: 12,
    lg: 16
} as const

/** The platform's own monospace, for a build whose fonts have not loaded (or failed to). */
const PLATFORM_MONO = Platform.select({ ios: "Menlo", default: "monospace" })

/**
 * IBM Plex, for text and for identifiers. Its slightly mechanical humanism belongs to records and
 * instruments, which is what these apps are, and it is neither the system face nor the Inter every
 * other app reaches for.
 *
 * One family per weight, not one family plus `fontWeight`: Android synthesises a bold by smearing
 * the regular face, which is worse than no custom face at all. Each is loaded by the app (see
 * `ThemeProvider`'s `fontsLoaded`), so until then every face here is `undefined` and the platform's
 * own is used - text has to render on the first frame, not after a download.
 */
export const SANS_FACES = {
    "400": "IBMPlexSans_400Regular",
    "500": "IBMPlexSans_500Medium",
    "600": "IBMPlexSans_600SemiBold",
    "700": "IBMPlexSans_700Bold"
} as const

export const MONO_FACE = "IBMPlexMono_400Regular"

export type FaceWeight = keyof typeof SANS_FACES

export const fonts = {
    mono: PLATFORM_MONO
} as const

export interface Brand {
    /** The solid band, the primary button's fill, a card's stripe. */
    accent: string
    /** Text and icons drawn on `accent`. */
    onAccent: string
    /** A tinted surface the accent sits behind: callouts and soft fills. */
    accentSoft: string
    /** The accent as text on a white surface. A light accent needs a darker ink to stay readable. */
    accentInk: string
}

export type BrandKey = "green" | "blue" | "yellow" | "red"

/** One row per app and network member. Every pair clears 4.5:1, on the accent and on white. */
export const BRANDS = {
    green: { accent: "#176b4d", onAccent: "#ffffff", accentSoft: "#dff1e9", accentInk: "#176b4d" },
    blue: { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" },
    yellow: { accent: "#f5b400", onAccent: "#17201c", accentSoft: "#fdf1cc", accentInk: "#8a5a00" },
    red: { accent: "#c8102e", onAccent: "#ffffff", accentSoft: "#fbe3e6", accentInk: "#c8102e" }
} as const satisfies Record<BrandKey, Brand>

// Light theme only, sourced from apps/web-demo/public/styles.css's :root palette.
export const palette = {
    ink: "#17201c",
    muted: "#66716b",
    /** A panel's own outline, against the canvas. */
    line: "#dce3de",
    /** The divider between rows inside one panel. Darker than `line` on purpose: a hairline has
     *  to survive a phone screen at arm's length, which is how these apps are watched. */
    rule: "#c9d2cb",
    // Warm, not pure white: these cards stand for paper records, and a panel that is the same
    // #ffffff as a browser's default reads as a surface floating on a tint instead.
    surface: "#fffefb",
    canvas: "#f4f7f4",
    warning: "#9b6b16",
    danger: "#a33b32",
    success: "#2f8f5b",
    // The wallet's green, so an app that names no brand renders in it.
    ...BRANDS.green
} as const

// A record, not `typeof palette`, so an overridden accent (any string) still satisfies it.
export type Palette = Record<keyof typeof palette, string>

export interface Theme {
    colors: Palette
    /** The size scale, each step already carrying the text face, so `...theme.type.sm` is all a
     *  style needs. A style that also sets `fontWeight` sets `fontFamily: theme.face(weight)`. */
    type: Record<keyof typeof typeScale, TypeStyle & { fontFamily?: string }>
    /** The face carrying `weight`; `undefined` until the app's fonts are loaded. */
    face: (weight?: FaceWeight) => string | undefined
    spacing: typeof spacing
    radii: typeof radii
    fonts: { mono: string | undefined }
}

function buildType(family: string | undefined): Theme["type"] {
    const entries = Object.entries(typeScale).map(([step, style]) => [step, { ...style, fontFamily: family }])
    return Object.fromEntries(entries) as Theme["type"]
}

const defaultTheme: Theme = {
    colors: palette,
    type: buildType(undefined),
    face: () => undefined,
    spacing,
    radii,
    fonts
}

const ThemeContext = createContext<Theme>(defaultTheme)

export interface ThemeProviderProps {
    /** A `BRANDS` row, or a member's own four colours; every other token stays shared across apps. */
    brand?: Brand
    /**
     * Whether the app has finished loading the faces in {@link SANS_FACES}. False (the default)
     * leaves every family unset, so text renders in the platform's own face on the first frame and
     * a build that never loads them still reads correctly. The app owns the loading, not this
     * provider: a theme should not do I/O, and every test that renders one would pay for it.
     */
    fontsLoaded?: boolean
    children?: ReactNode
}

// createElement instead of JSX keeps this a .ts file alongside the rest of the tokens.
export function ThemeProvider({ brand, fontsLoaded = false, children }: ThemeProviderProps) {
    const colors = brand ? { ...palette, ...brand } : palette
    const theme: Theme = {
        colors,
        type: buildType(fontsLoaded ? SANS_FACES["400"] : undefined),
        face: (weight = "400") => (fontsLoaded ? SANS_FACES[weight] : undefined),
        spacing,
        radii,
        fonts: { mono: fontsLoaded ? MONO_FACE : PLATFORM_MONO }
    }
    return createElement(ThemeContext.Provider, { value: theme }, children)
}

export function useTheme(): Theme {
    return useContext(ThemeContext)
}
