import type * as secureStoreModule from "expo-secure-store"

import type { Keystore } from "@coordination-network/expo-identity-keystore"
import { SECURE_STORE_KEYS } from "./storage-keys"

/** Wipes every identity secret: SecureStore keys, then the Keystore sweep. Resolves the Keystore deletion count. */
export async function eraseAll(keystore: Keystore, secureStore: typeof secureStoreModule): Promise<number> {
    for (const key of SECURE_STORE_KEYS) {
        await secureStore.deleteItemAsync(key)
    }

    return keystore.eraseAll()
}
