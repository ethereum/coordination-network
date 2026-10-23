import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { CompiledCircuit, CredentialArtifact, CredentialCircuit } from "./types"

export type { CompiledCircuit, CredentialArtifact, CredentialCircuit }

// Written as separate literals rather than a template so a bundler that resolves this
// entry can still see which files are referenced. The URLs are relative to the built
// module in `dist/`, which sits at the same depth as `src/`, so both resolve alike.
const URLS: Record<CredentialArtifact, URL> = {
    "circuit.json": new URL("../credential/circuit.json", import.meta.url),
    vk: new URL("../credential/vk", import.meta.url)
}

/** Where this package keeps `artifact`, as a `file:` URL. */
export function credentialArtifactUrl(artifact: CredentialArtifact): URL {
    return new URL(URLS[artifact])
}

/**
 * Where this package keeps `artifact`, as an absolute path, for callers that take a
 * path rather than the file's contents.
 */
export function credentialArtifactPath(artifact: CredentialArtifact): string {
    return fileURLToPath(URLS[artifact])
}

/** Reads the compiled credential circuit. */
export async function getCredentialCircuit(): Promise<CredentialCircuit> {
    return JSON.parse(await readFile(URLS["circuit.json"], "utf8")) as CredentialCircuit
}

/**
 * Reads the credential circuit's UltraHonk verification key, in the binary encoding
 * `UltraHonkVerifierBackend.verifyProof` takes.
 */
export async function getCredentialVerificationKey(): Promise<Uint8Array> {
    return new Uint8Array(await readFile(URLS.vk))
}
