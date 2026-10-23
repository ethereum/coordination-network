# @coordination-network/app-ui

The design system the reference apps share: one set of tokens, one set of screen components. Both
Expo apps consume it from source, so there is no build step and no second theme anywhere.

```tsx
import { BRANDS, Outcome, ThemeProvider } from "@coordination-network/app-ui"

export default function App() {
    return (
        <ThemeProvider brand={BRANDS.blue}>
            <Outcome tone="success" icon="check-circle" title="Registered" lines={["Not counted twice"]} />
        </ThemeProvider>
    )
}
```

## Tokens

`tokens.ts` holds the whole palette, the type scale, spacing, radii and the faces. Components read
them through `useTheme()`; nothing outside this package should write a hex value or a font size.
Spacing runs `xs` 4 to `xxl` 32; type runs `xs` 13 to `xl` 28. `line` outlines a panel against the
canvas and `rule` divides rows inside one — darker, because a hairline has to survive a phone screen
held up in front of a room.

## Type

IBM Plex Sans for text, IBM Plex Mono for identifiers. One family per weight (`SANS_FACES`), not one
family plus `fontWeight`: Android synthesises a bold by smearing the regular face, which is worse
than no custom face at all. `theme.type.sm` already carries the 400 face, so a plain style needs
nothing else; a style that sets `fontWeight` sets `fontFamily: theme.face("600")` beside it.

The app loads the faces and passes `fontsLoaded` to `ThemeProvider` — this package does no I/O, and
every test that renders a theme would otherwise pay for it. Until they load, and in any build where
they fail to, every family is unset and the platform's own face is used, so text draws on the first
frame either way. An app imports each weight from its own entry point
(`@expo-google-fonts/ibm-plex-sans/700Bold`) rather than the package index, which `require`s all
fourteen weights and their italics.

## Brands

A member's colour is four values, not one. `Brand` carries `accent` (the band, a primary button, a
card's stripe), `onAccent` (text drawn on the accent), `accentSoft` (a tinted surface) and
`accentInk` (the accent used as text on white). The two exist separately because the yellow accent is
unreadable as text: it needs dark ink on the band and a darker brown as text on white. `BRANDS`
has a row per `BrandKey` — `green` for the user wallet, and `blue`, `yellow` and `red` for the
network members — and every pair clears 4.5:1. `ThemeProvider({ brand })` merges the
four into the palette; an app that names no brand renders in green.

## Components

`Screen`, `AppBar`, `Sheet`, `Header`, `TabBar` and `Card` are the frame; `Button`, `Badge`,
`KeyValue`, `FieldGroup`, `Disclosure`, `StepList`, `EmptyState` and `Icon` are what goes in it.

`FieldGroup` rules between label/value rows and never at either end, where the panel's own outline
already draws the line: a credential, an identity and a stack are all records of something, and a
record reads as ruled rows rather than as fields spaced apart. `Card` takes `voided` for a record
the network has cancelled — the stripe turns to the danger colour whatever the issuer's is, and the
surface is washed with it, because a small red badge is not enough to see. `Outcome`'s icon is a
stamp: a ring in the tone's colour, two degrees off square, settling down from slightly too big.
It is the only flourish in either app; a verdict is the moment each flow exists for, and spending
the boldness twice would spend it. `Outcome` says how a flow ended — an icon in the tone's colour, a title and up to
three short lines, with anything longer folded behind a `Disclosure`. `MemberName` renders a
network member's name in its own ink and is a `Text`, so a consent sentence can name the member
mid-line rather than breaking around it. `Card` takes an issuer's colour as a left stripe,
`KeyValue` hides a one-sentence explanation behind an info icon, and a `StepList` step can report
the `existing` state: a record that was already on the network, which is not this run's success
and so never takes the green check.

## Motion

`motion.ts` is the only place a duration or a curve is written down. It exports `easing`
(`Easing.bezier(0.23, 1, 0.32, 1)`, ease-out), `durations`, and `entrances` — the three the apps
share: a step icon reaching its next state (180 ms), one sheet body replacing another (200 ms),
and a flow's result arriving (250 ms). `useEntering(entrance)` returns the value to hand an
`Animated.View`'s `entering` prop, and drops the movement when the system asks for less motion,
keeping the fade that says something arrived; `entering(entrance)` is the same builder without the
hook, for module scope. Only `transform` and `opacity` animate, so nothing crosses to the JS
thread. Nothing animates on a tab switch or a press — a tab is paid for dozens of times a session,
and the button's ripple already answers in under 150 ms.

## Tests

```
yarn workspace @coordination-network/app-ui test --watchman=false
```

`jest.setup.js` calls Reanimated's `setUpTests()`. Without it an `entering` animation never
resolves and every animated component renders at opacity 0. `src/testing.ts` holds the helpers the
apps' own suites reuse: `renderScreen`, `allText`, `press`, `findPressables`, `changeText`.
