import * as secureStore from "expo-secure-store"

import { getKeystore, type Keystore } from "@coordination-network/expo-identity-keystore"

/** Shared handles every test case runs against. */
export interface TestContext {
    /** The native Keystore module, or `null` where it isn't available (Expo Go, iOS). */
    keystore: Keystore | null
    /** `expo-secure-store`, for the `persistence` and `erase-all` cases. */
    secureStore: typeof secureStore
}

/** Builds the shared {@link TestContext} once, at app startup. */
export function createTestContext(): TestContext {
    return {
        keystore: getKeystore(),
        secureStore
    }
}
