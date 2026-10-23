import { deriveKeys, type Hex } from "@coordination-network/identity"
import type { RegistrationSignParams, RegistrationSignResult } from "@coordination-network/user-app-link"
import { buildRegistrationRequest } from "@coordination-network/user-client"
import type { UserAppPorts } from "../types"

export async function registrationSignHandler(
    ports: UserAppPorts,
    deviceSecret: Hex,
    params: RegistrationSignParams
): Promise<RegistrationSignResult> {
    const keys = deriveKeys(deviceSecret)
    return {
        request: buildRegistrationRequest(keys, {
            chainId: params.chainId,
            verifyingContract: params.verifyingContract
        }),
        securityLevel: await ports.deviceKey.getSecurityLevel()
    }
}
