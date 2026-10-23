import { deriveEddsaKeypair, eddsaPeerPointBytes } from "@coordination-network/identity"
import type { DeviceSigner } from "@coordination-network/credential"
import { ChainStateLoader, Wallet } from "@coordination-network/wallet"
import { hexToBytes } from "./hex"
import { nowFn } from "./now"
import type { DeviceKey, KeyPrompt, UserAppPorts } from "./types"

/** Its own text, so the person never sees two identical dialogs back to back. */
const ECDH_PROMPT: KeyPrompt = {
    title: "Unlock your credentials",
    subtitle: "Needed once each time the app starts"
}

/**
 * The Baby Jubjub identity seed, rooted in the hardware ECDH rather than the device secret.
 * `deriveEddsaKeypair` returns `seed` as a `0x`-prefixed hex string — handing that string to
 * Semaphore derives a different identity (`DERIVATION.md` §12.4); `Wallet.identitySeed` must be
 * the 32 raw bytes decoded from it.
 */
export async function resolveIdentitySeed(deviceKey: DeviceKey): Promise<Uint8Array> {
    const sharedSecret = await deviceKey.ecdh(eddsaPeerPointBytes(), ECDH_PROMPT)
    return hexToBytes(deriveEddsaKeypair(sharedSecret).seed)
}

/** The seed is the same for the life of the process, so the person is asked for it once. */
export interface IdentitySeedCache {
    resolve(): Promise<Uint8Array>
    clear(): void
}

export function createIdentitySeedCache(deviceKey: DeviceKey): IdentitySeedCache {
    let pending: Promise<Uint8Array> | null = null
    return {
        resolve() {
            if (pending === null) {
                const attempt = resolveIdentitySeed(deviceKey)
                pending = attempt
                // A cancelled prompt must not be cached: the next operation asks again.
                attempt.catch(() => {
                    if (pending === attempt) pending = null
                })
            }
            return pending
        },
        clear() {
            pending = null
        }
    }
}

/**
 * `listCredentials` never syncs — there is no single authority to sync a mixed-issuer listing
 * against — so this sentinel documents that, and would surface loudly if a future bug called it.
 */
export const neverLoadChainState: ChainStateLoader = async () => {
    throw new Error("chain state must not be requested outside a per-request authority")
}

/** A listing wallet's identity seed: like `neverLoadChainState`, loud if a future bug reaches for it. */
export const neverSeed = async (): Promise<Uint8Array> => {
    throw new Error("a listing must not ask the device key for the identity seed")
}

const neverSign = async (): Promise<Uint8Array> => {
    throw new Error("a listing must not ask the device key to sign")
}

/** A listing wallet's signer: it reads the public key, which raises no prompt, and never signs. */
export const listingSigner = (deviceKey: DeviceKey): DeviceSigner => ({
    getPublicKeyJwk: () => deviceKey.getPublicKeyJwk(),
    sign: neverSign,
    signDigest: neverSign
})

/**
 * A fresh `Wallet` per request, scoped to one member's authority. The private `Wallet` gets a
 * constant-`true` consent prompt: the person has already been asked once, at the link boundary,
 * and prompting again here would show a second screen for one `presentation.create`.
 *
 * `prompt` is what a signature raises. `null` builds a wallet for listing and syncing, which must
 * never touch a key: its seed and signer throw.
 */
export function buildWallet(
    ports: UserAppPorts,
    seeds: IdentitySeedCache,
    loadChainState: ChainStateLoader,
    prompt: KeyPrompt | null
): Wallet {
    return new Wallet({
        identitySeed: prompt === null ? neverSeed : () => seeds.resolve(),
        deviceSigner: prompt === null ? listingSigner(ports.deviceKey) : ports.deviceKey.signerFor(prompt),
        consent: async () => true,
        proofGenerator: ports.proofGenerator,
        store: ports.store,
        now: () => nowFn(ports),
        loadChainState
    })
}
