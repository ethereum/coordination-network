import { deriveKeys, type Hex } from "@coordination-network/identity"
import { metaStealthAddressFromKeys } from "@coordination-network/user-client"
import type { DeviceKey, PublicIdentity } from "./types"

/** Assembles the four values the Identity screen shows — `Wallet` exposes none of them directly. */
export async function assembleIdentity(deviceSecret: Hex, deviceKey: DeviceKey): Promise<PublicIdentity> {
    const keys = deriveKeys(deviceSecret)

    return {
        networkId: keys.networkId,
        metaStealthAddress: metaStealthAddressFromKeys(keys),
        accountPublicKey: keys.account.uncompressedPublicKey,
        securityLevel: await deviceKey.getSecurityLevel()
    }
}
