import type { Hex } from "@coordination-network/identity"
import type { Store } from "@coordination-network/wallet"

/**
 * This package holds exactly one identity, so unlike `Wallet`'s `key:`-prefixed store (built for
 * several imported keys) the device secret lives under one fixed key.
 */
export const DEVICE_SECRET_KEY = "user-app-core:device-secret"

export async function readDeviceSecret(store: Store): Promise<Hex | null> {
    return (await store.get(DEVICE_SECRET_KEY)) as Hex | null
}

export async function writeDeviceSecret(store: Store, secret: Hex): Promise<void> {
    await store.set(DEVICE_SECRET_KEY, secret)
}
