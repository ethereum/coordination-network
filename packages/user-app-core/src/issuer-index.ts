import type { Hex32 } from "@coordination-network/user-app-link"
import type { Store } from "@coordination-network/wallet"
import type { ConsentScope } from "./types"

/**
 * `issuerNetworkId` is asserted by the caller, so `credential.issue` checks it against the chain:
 * an entry is written, or honoured as `alreadyHeld`, only for a key in the member's
 * `issuerKeysOf` list. Listings and presentation read entries as written, including any from before
 * this check.
 */
const ISSUER_INDEX_PREFIX = "user-app-core:issuer-index:"

/**
 * One entry per issuer the wallet holds a credential from. It carries what the credential body
 * cannot give back — the plaintext programme and the issuer — so a listing can name both.
 */
export interface IssuerIndexEntry {
    credentialId: string
    /** The Baby Jubjub key that signed the credential, as decimal field elements. */
    issuerPublicKey: [string, string]
    /** Where the issuer published its approved-issuer set at issuance. Nothing reads it back: a
     *  presentation reads the verifier's lists. */
    issuersUrl: string
    programme: string
    country: string
    issuedAt: number
}

/**
 * One key per issuer *and* approval scope, so a member running two programmes can issue for both.
 * The two scope parts are percent-encoded, which escapes the separator, so the issuer id is always
 * the first of exactly three segments.
 */
const keyFor = (issuerNetworkId: Hex32, scope: ConsentScope): string =>
    `${ISSUER_INDEX_PREFIX}${issuerNetworkId.toLowerCase()}:${encodeURIComponent(scope.programme)}:${encodeURIComponent(scope.country)}`

export async function readIssuerEntry(
    store: Store,
    issuerNetworkId: Hex32,
    scope: ConsentScope
): Promise<IssuerIndexEntry | null> {
    const raw = await store.get(keyFor(issuerNetworkId, scope))
    return raw === null ? null : (JSON.parse(raw) as IssuerIndexEntry)
}

/** Every entry the wallet holds, for the joins that start from a credential rather than an issuer. */
export async function listIssuerEntries(store: Store): Promise<(IssuerIndexEntry & { issuerNetworkId: Hex32 })[]> {
    const entries: (IssuerIndexEntry & { issuerNetworkId: Hex32 })[] = []
    for (const key of await store.list()) {
        if (!key.startsWith(ISSUER_INDEX_PREFIX)) continue
        const raw = await store.get(key)
        if (raw === null) continue
        entries.push({
            ...(JSON.parse(raw) as IssuerIndexEntry),
            issuerNetworkId: key.slice(ISSUER_INDEX_PREFIX.length).split(":")[0] as Hex32
        })
    }
    return entries
}

/** The entry carries its own scope, so it is what the key is built from. */
export async function writeIssuerEntry(store: Store, issuerNetworkId: Hex32, entry: IssuerIndexEntry): Promise<void> {
    await store.set(keyFor(issuerNetworkId, entry), JSON.stringify(entry))
}

/** Removes the entries naming any of `credentialIds`; every other entry stays. */
export async function deleteIssuerEntries(store: Store, credentialIds: ReadonlySet<string>): Promise<void> {
    for (const key of await store.list()) {
        if (!key.startsWith(ISSUER_INDEX_PREFIX)) continue
        const raw = await store.get(key)
        if (raw === null) continue
        let credentialId: string
        try {
            credentialId = (JSON.parse(raw) as IssuerIndexEntry).credentialId
        } catch {
            continue
        }
        if (credentialIds.has(credentialId)) await store.delete(key)
    }
}
