import {
    base64ToBytes,
    bytesToBase64,
    createDeviceSigner,
    getKeystore,
    KEYSTORE_ERROR_CODES,
    keystoreErrorCode,
    sec1ToJwk,
    SoftwareKeystore,
    type Keystore
} from "@coordination-network/expo-identity-keystore"
import { DEVICE_ATTESTATION_CHALLENGE, DeviceKeyError, type DeviceKey } from "@coordination-network/user-app-core"
import type { SecurityLevel } from "@coordination-network/user-app-link"

export const SIGNING_KEY_ALIAS = "user-app.signing-key.v2"
export const AGREEMENT_KEY_ALIAS = "user-app.agreement-key.v2"
/** The one-key build's alias. Only ever deleted: a credential bound to it cannot be re-bound. */
export const LEGACY_DEVICE_KEY_ALIAS = "user-app.device-key"
/** The pair generated before the signing key was attested. Only ever deleted, like the one-key alias. */
export const LEGACY_SIGNING_KEY_ALIAS = "user-app.signing-key"
export const LEGACY_AGREEMENT_KEY_ALIAS = "user-app.agreement-key"

const LEGACY_ALIASES = [LEGACY_DEVICE_KEY_ALIAS, LEGACY_SIGNING_KEY_ALIAS, LEGACY_AGREEMENT_KEY_ALIAS]

/** Every alias the device keys have lived under. The same keystore also holds expo-secure-store's key. */
const DEVICE_KEY_ALIASES = [...LEGACY_ALIASES, SIGNING_KEY_ALIAS, AGREEMENT_KEY_ALIAS]

/** Only the signing key is attested: it is the credential's confirmation key, the one key the issuer sees. */
const ATTESTATION_CHALLENGE = bytesToBase64(new TextEncoder().encode(DEVICE_ATTESTATION_CHALLENGE))

export interface DeviceKeyOptions {
    /** Called once a key reports it was invalidated, before the failing call throws. */
    onInvalidated: () => void
    /** Waits between re-reads of a missing alias. Replaced in tests so they do not sleep. */
    sleep?: (ms: number) => Promise<void>
}

const LEVELS_STRONGEST_FIRST: SecurityLevel[] = ["STRONGBOX", "TRUSTED_ENVIRONMENT", "SOFTWARE", "UNKNOWN"]

/**
 * `getKeystore()` is null off a dev build and on iOS, where the module has no implementation.
 * The software fallback keeps the two-key model rather than pretending to hardware it hasn't got —
 * but it holds its keys in memory only, so it is **one per process and gone on relaunch**. It has to
 * be a singleton: a second instance would mint a second device key, and the two would open
 * different `deviceKeyCommitment`s, so a credential stored against one could never be presented.
 * The same follows across a relaunch: off a dev build every held credential becomes unpresentable,
 * and `securityLevel: SOFTWARE` is the signal that this is what you are on.
 */
let fallbackKeystore: SoftwareKeystore | null = null

const resolveKeystore = (): Keystore => {
    const native = getKeystore()
    if (native !== null) return native
    fallbackKeystore ??= new SoftwareKeystore()
    return fallbackKeystore
}

async function guarded<T>(options: DeviceKeyOptions, use: () => Promise<T>): Promise<T> {
    try {
        return await use()
    } catch (error) {
        const code = keystoreErrorCode(error)
        if (code === KEYSTORE_ERROR_CODES.userCanceled) throw new DeviceKeyError("USER_CANCELED")
        if (code === KEYSTORE_ERROR_CODES.keyInvalidated) {
            options.onInvalidated()
            throw new DeviceKeyError("KEY_INVALIDATED")
        }
        if (code === KEYSTORE_ERROR_CODES.authenticationFailed) {
            throw new DeviceKeyError("AUTHENTICATION_FAILED", error instanceof Error ? error.message : undefined)
        }
        throw error
    }
}

/** Waits before each re-read of an alias that read missing. */
const PROBE_DELAYS_MS = [0, 200, 600]

/**
 * Android's `containsAlias` returns false for any KeyStoreException, not only a missing key, so a
 * transient fault reads as a gone key. A key is taken as gone only if every read says so.
 */
async function hasKeyAfterReprobe(keystore: Keystore, alias: string, sleep: (ms: number) => Promise<void>) {
    for (const delay of PROBE_DELAYS_MS) {
        if (delay > 0) await sleep(delay)
        if (await keystore.hasKey(alias)) return true
    }
    return false
}

async function deleteDeviceKeys(keystore: Keystore): Promise<void> {
    for (const alias of DEVICE_KEY_ALIASES) await keystore.deleteKey(alias)
}

/**
 * The spec's two device keys: a signing key whose every use needs the user present, and an
 * agreement key whose ECDH roots the Baby Jubjub identity key. They exist together or not at all:
 * one half of the pair, or the legacy aliases without a complete pair, means the key a credential
 * was bound to is gone, so every alias is deleted and both keys regenerated. That is also how the
 * unattested pair is replaced, once, under the `.v2` aliases. A legacy alias beside a complete
 * pair is only deleted. What was bound to the old keys is the
 * service's `removeUnboundCredentials` to find.
 */
export function createDeviceKey(options: DeviceKeyOptions): Promise<DeviceKey> {
    return provisionDeviceKey(options, true)
}

async function provisionDeviceKey(options: DeviceKeyOptions, reprobe: boolean): Promise<DeviceKey> {
    const keystore = resolveKeystore()
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const has = (alias: string) => (reprobe ? hasKeyAfterReprobe(keystore, alias, sleep) : keystore.hasKey(alias))

    // The legacy aliases are not re-probed: a false read there only means nothing to delete.
    const [hasSigning, hasAgreement, ...hasLegacy] = await Promise.all([
        has(SIGNING_KEY_ALIAS),
        has(AGREEMENT_KEY_ALIAS),
        ...LEGACY_ALIASES.map((alias) => keystore.hasKey(alias))
    ])

    if (hasSigning && hasAgreement) {
        for (const [index, alias] of LEGACY_ALIASES.entries()) {
            if (hasLegacy[index]) await keystore.deleteKey(alias)
        }
    } else {
        await deleteDeviceKeys(keystore)
        await keystore.generateKey(SIGNING_KEY_ALIAS, { purpose: "sign", attestationChallenge: ATTESTATION_CHALLENGE })
        await keystore.generateKey(AGREEMENT_KEY_ALIAS, { purpose: "agree" })
    }

    return {
        async getPublicKeyJwk() {
            return sec1ToJwk(base64ToBytes(await keystore.getPublicKey(SIGNING_KEY_ALIAS)))
        },
        signerFor(prompt) {
            const signer = createDeviceSigner(keystore, SIGNING_KEY_ALIAS, prompt)
            return {
                getPublicKeyJwk: () => signer.getPublicKeyJwk(),
                sign: (message) => guarded(options, () => signer.sign(message)),
                signDigest: (digest) => guarded(options, () => signer.signDigest(digest))
            }
        },
        ecdh: (peerPublicKey, prompt) =>
            guarded(options, async () =>
                base64ToBytes(await keystore.ecdh(AGREEMENT_KEY_ALIAS, bytesToBase64(peerPublicKey), prompt))
            ),
        async getSecurityLevel() {
            const levels = await Promise.all([
                keystore.getSecurityLevel(SIGNING_KEY_ALIAS),
                keystore.getSecurityLevel(AGREEMENT_KEY_ALIAS)
            ])
            return levels.reduce((lowest, level) =>
                LEVELS_STRONGEST_FIRST.indexOf(level) > LEVELS_STRONGEST_FIRST.indexOf(lowest) ? level : lowest
            )
        },
        getAttestationChain: () => keystore.getAttestationChain(SIGNING_KEY_ALIAS)
    }
}

/** Deletes this app's device-key aliases and generates a fresh pair, for a key that reported itself invalidated. */
export async function replaceDeviceKeys(options: DeviceKeyOptions): Promise<DeviceKey> {
    await deleteDeviceKeys(resolveKeystore())
    // No re-probe: the keys were just deleted, and KEY_INVALIDATED is definitive.
    return provisionDeviceKey(options, false)
}

/**
 * Removes every key in this app's keystore, hardware or fallback. On Android that includes
 * expo-secure-store's own wrapping key, so every SecureStore item, the device secret among them, is
 * lost with it: this is for erasing everything, and never for recovering a key.
 */
export async function eraseDeviceKey(): Promise<number> {
    const erased = await resolveKeystore().eraseAll()
    // Dropped as well as erased, so the next `createDeviceKey` starts from a clean instance rather
    // than one that has been emptied underneath it.
    fallbackKeystore = null
    return erased
}
