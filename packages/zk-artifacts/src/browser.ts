import type { CompiledCircuit, CredentialArtifact, CredentialCircuit } from "./types"

export type { CompiledCircuit, CredentialArtifact, CredentialCircuit }

// Vite and webpack only rewrite `new URL(<string literal>, import.meta.url)`, so each
// artifact needs its own literal: build one from a variable and the bundler emits no
// asset and the URL is wrong at runtime.
const URLS: Record<CredentialArtifact, URL> = {
    "circuit.json": new URL("../credential/circuit.json", import.meta.url),
    vk: new URL("../credential/vk", import.meta.url)
}

/** Where the bundler placed `artifact`. */
export function credentialArtifactUrl(artifact: CredentialArtifact): URL {
    return new URL(URLS[artifact])
}

const fetchArtifact = async (artifact: CredentialArtifact): Promise<Response> => {
    const response = await fetch(URLS[artifact])
    if (!response.ok) {
        throw new Error(`failed to fetch ${artifact}: ${response.status} ${response.statusText}`)
    }
    return response
}

/** Fetches the compiled credential circuit. */
export async function getCredentialCircuit(): Promise<CredentialCircuit> {
    return (await (await fetchArtifact("circuit.json")).json()) as CredentialCircuit
}

/**
 * Fetches the credential circuit's UltraHonk verification key, in the binary encoding
 * `UltraHonkVerifierBackend.verifyProof` takes.
 */
export async function getCredentialVerificationKey(): Promise<Uint8Array> {
    return new Uint8Array(await (await fetchArtifact("vk")).arrayBuffer())
}
