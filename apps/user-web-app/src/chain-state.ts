import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import type { ChainStateLoader } from "@coordination-network/wallet"

async function json<T>(url: string): Promise<T> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url} returned ${response.status}`)
    return response.json() as Promise<T>
}

export function memberChainStateLoader(memberUrl: string): ChainStateLoader {
    return async () => {
        const [issuerResponse, revocationResponse] = await Promise.all([
            json<{ leaves: string[]; root: string }>(`${memberUrl}/v1/issuers`),
            json<{ root: string; snapshot: string }>(`${memberUrl}/v1/revocations/snapshot`)
        ])
        const approvedIssuers = ApprovedIssuerSet.fromLeaves(issuerResponse.leaves.map(BigInt))
        const revocations = RevocationRegistry.import(revocationResponse.snapshot)
        return {
            approvedIssuers,
            approvedIssuerRoot: BigInt(issuerResponse.root),
            revocations,
            revocationRoot: BigInt(revocationResponse.root)
        }
    }
}
