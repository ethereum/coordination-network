import { WalletError, type CredentialInfo, type WalletChainState } from "@coordination-network/wallet"
import {
    LinkError,
    type Hex32,
    type PresentationCreateParams,
    type PresentationCreateResult
} from "@coordination-network/user-app-link"
import { listsMatchChain, readLists } from "../chain-state"
import { mapWalletError } from "../errors"
import { bytesToHex, hexToBytes } from "../hex"
import { listIssuerEntries, type IssuerIndexEntry } from "../issuer-index"
import { postToMember, verifyResponseSchema } from "../member-api"
import { latestExpiring, matchingCredentials } from "../selection"
import { buildWallet, neverLoadChainState, type IdentitySeedCache } from "../wallet-factory"
import type { UserAppPorts } from "../types"

/** A held credential together with the issuer entry naming its plaintext programme and issuer. */
interface Candidate extends CredentialInfo {
    issuerNetworkId: Hex32
    entry: IssuerIndexEntry
}

/** A candidate checked against the network state, carrying the state that check read. */
interface SyncedCandidate extends Candidate {
    chainState: WalletChainState
}

export async function presentationCreateHandler(
    ports: UserAppPorts,
    seeds: IdentitySeedCache,
    params: PresentationCreateParams
): Promise<PresentationCreateResult> {
    const step = (name: string) => ports.progress("presentation.create", name)

    // The state is read below, once the request is known to have candidates, so the wallet is built
    // without an authority and handed one per call. This one only lists and syncs: it holds no key.
    const wallet = buildWallet(ports, seeds, neverLoadChainState, null)

    /**
     * The same for every candidate, so the request reads it once however many credentials it has
     * to check — and a verifier that cannot serve the lists, or a chain that cannot be read, fails
     * the whole request, since no candidate can be judged without them.
     */
    async function networkState(): Promise<WalletChainState> {
        const [lists, roots] = await Promise.allSettled([
            readLists(ports.http, params.issuersUrl, params.revocationsUrl),
            ports.roots.currentRoots()
        ])
        if (lists.status === "rejected") {
            throw new LinkError(
                "VERIFIER_UNREACHABLE",
                lists.reason instanceof Error ? lists.reason.message : "the verifier's lists are unreadable"
            )
        }
        if (roots.status === "rejected") {
            // Fixed text: a viem message carries the RPC URL, which can hold a provider key.
            throw new LinkError("CHAIN_UNREACHABLE", "the current roots could not be read from chain")
        }
        if (!listsMatchChain(lists.value, roots.value)) {
            throw new LinkError("VERIFIER_UNREACHABLE", "the verifier's lists do not match the chain")
        }
        return {
            ...lists.value,
            approvedIssuerRoot: roots.value.approvedIssuerRoot,
            revocationRoot: roots.value.revocationRoot
        }
    }

    async function readCandidates(): Promise<Candidate[]> {
        const infoById = new Map((await wallet.listCredentials()).map((info) => [info.id, info]))
        const held = (await listIssuerEntries(ports.store)).flatMap(({ issuerNetworkId, ...entry }) => {
            const info = infoById.get(entry.credentialId)
            // An entry whose credential is gone names a snapshot for nothing; a credential with
            // no entry has no snapshot to be checked against. Neither can be proved.
            return info === undefined ? [] : [{ ...info, issuerNetworkId, entry }]
        })
        return matchingCredentials(held, params)
    }

    step("Checking your credential")
    const candidates = await readCandidates()

    // One read for the whole request: every member serves the same network tree, and reading it
    // per issuer was itself what told whoever served it which issuer a credential came from. The
    // state is kept so the proof is built from the same read, not a second one that could disagree.
    let chainState: WalletChainState | undefined
    if (candidates.length > 0) {
        const state = await networkState()
        chainState = state
        for (const candidate of candidates) {
            await wallet.syncCredential(candidate.id, async () => state)
        }
    }

    const synced = (await readCandidates()).flatMap<SyncedCandidate>((candidate) =>
        chainState === undefined ? [] : [{ ...candidate, chainState }]
    )
    const selected = latestExpiring(synced.filter((candidate) => candidate.status === "valid"))
    if (selected === null) {
        const revoked = latestExpiring(synced.filter((candidate) => candidate.status === "revoked"))
        if (revoked !== null) {
            // The refusal itself says the person holds a revoked credential, which a proof never
            // would, so it goes through the same gate the proof does.
            const told = await ports.review({
                kind: "revoked",
                verifier: params.audience,
                programme: params.programme,
                country: params.country,
                issuerNetworkId: revoked.issuerNetworkId
            })
            if (!told) throw new LinkError("CONSENT_DENIED", "the refusal was not shared")
            throw new LinkError("CREDENTIAL_REVOKED", `the ${params.programme} credential you hold has been revoked`)
        }
        throw new LinkError(
            "NO_CREDENTIAL",
            `no held credential matches programme "${params.programme}"/"${params.country}"`
        )
    }

    const approved = await ports.review({
        kind: "proof",
        verifier: params.audience,
        programme: params.programme,
        country: params.country,
        issuerNetworkId: selected.issuerNetworkId
    })
    if (!approved) throw new LinkError("CONSENT_DENIED", "the proof was not shared")

    step("Proving")
    const presenter = buildWallet(ports, seeds, neverLoadChainState, {
        title: "Share a proof",
        subtitle: `Proves your ${params.programme} credential (${params.country})`
    })
    let proof
    try {
        proof = await presenter.present(
            selected.id,
            {
                challenge: hexToBytes(params.challenge),
                audience: params.audience,
                currentTime: params.currentTime,
                programme: params.programme,
                country: params.country
            },
            async () => selected.chainState
        )
    } catch (error) {
        if (error instanceof WalletError) throw mapWalletError(error)
        // A raw prover failure, not a WalletError - keep it distinguishable from NO_CREDENTIAL above.
        throw new LinkError("PROOF_FAILED", error instanceof Error ? error.message : "proof generation failed")
    }

    step("Sharing")
    // Only the id comes back: the verifier's own `ok` would be the verifier reporting on itself,
    // and its member app can read the recorded outcome from its own server under this id.
    const posted = await postToMember(
        ports.http,
        params.responseUrl,
        { requestId: params.requestId, proof: bytesToHex(proof.proof), publicInputs: proof.publicInputs },
        { status: 200, schema: verifyResponseSchema, unreachable: "VERIFIER_UNREACHABLE" }
    )
    // An issuer's error body is the issuer refusing this person, and the wallet relays it. A
    // verifier has nothing to refuse — it is answering a request the wallet made — so an error
    // body from it is just an answer the wallet cannot use.
    if (posted.refusal) {
        throw new LinkError("VERIFIER_UNREACHABLE", `${params.responseUrl} returned an unusable response`)
    }
    return { verificationId: posted.value.verificationId }
}
