/**
 * Stands in for the WASM proving stack — `@aztec/bb.js` and `@noir-lang/noir_js` — in the Android
 * bundle; `metro.config.js` resolves both packages here. Proving on device goes through
 * `@coordination-network/noir-prover-native`, and the witness is built by `zkPresentationInputsToWitness`,
 * so the only route to this module — `ZkCredentialProofSystem.create` — is never taken. These throw
 * rather than return a dummy so a mistaken call fails at the call site instead of somewhere further in.
 */
function unavailable(name: string): never {
    throw new Error(`${name} is unavailable on device: proving uses the native prover, not WASM`)
}

export const Barretenberg = {
    new: (): never => unavailable("Barretenberg.new")
}

export class UltraHonkBackend {
    constructor() {
        unavailable("UltraHonkBackend")
    }
}

export class Noir {
    constructor() {
        unavailable("Noir")
    }
}
