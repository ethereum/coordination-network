import type { TestContext } from "./context"

/**
 * Which layer of the stack a test case exercises:
 * - `"js"`: pure JS/TS, runs identically under Hermes (device) and Node (jest) — the SDK's own correctness.
 * - `"device"`: needs a real RN runtime (polyfills, `expo-secure-store`) but no custom native module.
 * - `"keystore"`: needs the `@coordination-network/expo-identity-keystore` Expo Module (Android Keystore).
 */
export type Tier = "js" | "device" | "keystore"

/**
 * Which key family a case belongs to, mirroring the "three keys, three signatures"
 * design: the account key (secp256k1), the device/confirmation key (P-256), the
 * EdDSA revocation key (Baby Jubjub), and the issuer-side verification gates.
 */
export type Group = "account" | "device-key" | "eddsa" | "issuer"

/** One assertion within a case: a labelled pass/fail with an optional value or diff. */
export interface Check {
    /** What this assertion checks, in plain terms. */
    label: string
    /** Whether the assertion held. */
    ok: boolean
    /** The value on pass, or `expected X · got Y` on fail. */
    detail?: string
}

/** Result of running a single {@link TestCase}. */
export interface TestDetail {
    /** Whether every check passed. */
    ok: boolean
    /** Wall-clock duration of `run()`, in milliseconds. */
    ms: number
    /** The assertions this run made, in order. */
    checks: Check[]
    /** Optional context that isn't an assertion (pinned constants, timings). */
    note?: string
}

/** A single test case in the shared js/device/keystore test-case registry. */
export interface TestCase {
    /** Stable identifier — the primary label in the UI and the React key in the list. */
    id: string
    /** Display name, kept for jest output and the registry test. */
    name: string
    /** One-line "what this proves", shown as the row subtitle. */
    description: string
    /** Which key family this case belongs to. */
    group: Group
    /** Which tier this case belongs to. */
    tier: Tier
    /** Runs the case against `ctx`, resolving to its result — never rejects. */
    run(ctx: TestContext): Promise<TestDetail>
}
