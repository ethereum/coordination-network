import type { CompiledCircuit } from "@noir-lang/noir_js"

/** The files this package publishes for the credential circuit. */
export type CredentialArtifact = "circuit.json" | "vk"

/**
 * What nargo actually writes. `CompiledCircuit` covers the four fields
 * `@noir-lang/noir_js` consumes; these two record which compiler produced the
 * artifact and the program hash it settled on, and are the only provenance the
 * package carries.
 */
export type CredentialCircuit = CompiledCircuit & {
    /** The nargo release that compiled it, as `1.0.0-beta.22+<commit>`. */
    readonly noir_version: string
    /** nargo's own hash of the compiled program, a u64 serialised as a string. */
    readonly hash: string
}

/**
 * The compiled credential circuit, as `@noir-lang/noir_js` and
 * `@coordination-network/credential` consume it.
 */
export type { CompiledCircuit }
