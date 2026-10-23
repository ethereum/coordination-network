import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import type { WalletChainState } from "@coordination-network/wallet"
import type { ChainRoots, HttpClient } from "./types"

interface IssuersResponseBody {
    leaves: string[]
}

interface RevocationSnapshotResponseBody {
    snapshot: string
}

/** The trees a server's two lists rebuild, with no root attached. */
export type ChainLists = Pick<WalletChainState, "approvedIssuers" | "revocations">

async function readIssuerSet(http: HttpClient, issuersUrl: string): Promise<ApprovedIssuerSet> {
    const response = await http.getJson(issuersUrl)
    if (response.status !== 200) {
        throw new Error(`GET ${issuersUrl} returned ${response.status}`)
    }
    const { leaves } = response.body as IssuersResponseBody

    return ApprovedIssuerSet.fromLeaves(leaves.map((leaf) => BigInt(leaf)))
}

async function readRevocations(http: HttpClient, revocationsUrl: string): Promise<RevocationRegistry> {
    const response = await http.getJson(revocationsUrl)
    if (response.status !== 200) {
        throw new Error(`GET ${revocationsUrl} returned ${response.status}`)
    }
    const { snapshot } = response.body as RevocationSnapshotResponseBody

    return RevocationRegistry.import(snapshot)
}

/**
 * Bulk data only: the `root` each endpoint also serves is not read, because the server choosing
 * both halves of the comparison makes it pass whatever it serves. The caller pairs these trees
 * with roots read from chain, and `listsMatchChain` rejects a pair that disagrees.
 */
export async function readLists(http: HttpClient, issuersUrl: string, revocationsUrl: string): Promise<ChainLists> {
    const [approvedIssuers, revocations] = await Promise.all([
        readIssuerSet(http, issuersUrl),
        readRevocations(http, revocationsUrl)
    ])
    return { approvedIssuers, revocations }
}

/** Both roots, and the issuer set's leaf count, which with its root fixes every leaf. */
export function listsMatchChain(lists: ChainLists, chain: ChainRoots): boolean {
    return (
        lists.approvedIssuers.root === chain.approvedIssuerRoot &&
        lists.approvedIssuers.leafCount === chain.approvedIssuerLeafCount &&
        lists.revocations.root === chain.revocationRoot
    )
}
