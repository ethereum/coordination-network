import assert from "node:assert/strict"
import {
    Address,
    Chain,
    Hex,
    PublicClient,
    createPublicClient,
    createWalletClient,
    defineChain,
    http,
    nonceManager
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ApprovalResolver, Hex32, Resolver, RevocationWriter } from "@coordination-network/credential"
import {
    DirectRevocationWriter,
    SemaphoreGroupClient,
    SemaphoreRevocationProver,
    SponsoredRelay,
    SponsoredRevocationWriter
} from "@coordination-network/network-member-client"
import type { RevocationProver, RevocationRegistryWriter } from "@coordination-network/network-member-client"
import { NetworkMemberProof, RegistryLocation, RevocationAction } from "@coordination-network/network-member-proof"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { Identity } from "@semaphore-protocol/identity"
import { withLogWindow } from "./chain-logs"
import { Config, SponsoredConfig } from "./config"
import { connectSponsoredStack } from "./sponsored-stack"

/** The `Revocation` fragments this service needs, inlined like registration-ports.ts. The tree
 *  lives here, under the registry id the `CredentialRevocationRegistry` was given at deployment. */
const REVOCATION_ABI = [
    {
        type: "function",
        name: "isRevoked",
        stateMutability: "view",
        inputs: [
            { name: "registryId", type: "uint256" },
            { name: "revocationCommitment", type: "uint256" }
        ],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "getRevocationRoot",
        stateMutability: "view",
        inputs: [{ name: "registryId", type: "uint256" }],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "getRevocationTreeLeafCount",
        stateMutability: "view",
        inputs: [{ name: "registryId", type: "uint256" }],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "getLeaf",
        stateMutability: "view",
        inputs: [
            { name: "registryId", type: "uint256" },
            { name: "index", type: "uint256" }
        ],
        outputs: [
            { name: "value", type: "uint256" },
            { name: "nextValue", type: "uint256" }
        ]
    }
] as const

/** The `CredentialRevocationRegistry` getters this service reads. `isValidRoot` takes no registry
 *  id: one tree holds the whole network's revocations, so a verification has nothing
 *  issuer-specific to pass. The writes go through network-member-client's own writers. */
const CREDENTIAL_REVOCATION_REGISTRY_ABI = [
    { type: "function", name: "REVOCATION", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "REGISTRY_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "SEMAPHORE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    {
        type: "function",
        name: "NETWORK_MEMBER_GROUP_ID",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "isValidRoot",
        stateMutability: "view",
        inputs: [{ name: "revocationRoot", type: "uint256" }],
        outputs: [{ type: "bool" }]
    }
] as const

/** How many times a revoke recomputes its low-leaf index and resubmits the same proof before
 *  giving up. Three covers a foreign member landing a write mid-flight; a contended tree that
 *  loses three races in a row is a problem a retry won't fix. */
const REVOKE_ATTEMPTS = 3

/** The approval reads a revocation backing delegates unchanged, rather than reimplementing them. */
type ApprovalDelegate = ApprovalResolver & Pick<Resolver, "getCredentialPublicKey">

/**
 * What `/v1/revocations/snapshot` and `/v1/verify` need from the server's revocation state: a
 * `Resolver & RevocationWriter` for the credential-issuance gate, plus the mirror and on-chain
 * location (`null` when there is none) a snapshot publishes.
 */
export interface RevocationBacking extends Resolver, RevocationWriter {
    /** The `Revocation` service holding the tree, not the registry that gates writes on it: paired
     *  with `registryId`, it is what a client needs to read the tree directly. */
    registryAddress: `0x${string}` | null
    registryId: bigint | null
    mirror: RevocationRegistry
    /** Whether `root` is one a verifier should currently accept: the live root or one still inside
     *  its window, chain-backed; the mirror's own root otherwise. No registry argument, because
     *  the whole network revokes into one tree — asking which tree would name the issuer. */
    isValidRoot(root: bigint): Promise<boolean>
    /**
     * Brings the mirror back in line with the chain. The tree belongs to the whole network, so a
     * revocation another member landed reaches this process no other way: nothing here watches the
     * chain, and `revoke` only ever updates the mirror from this server's own writes. Every path
     * that hands the mirror to someone else — the snapshot a wallet proves against, the listing an
     * operator reads — calls this first, or it serves a tree that is missing other members' work.
     */
    refresh(): Promise<void>
    /** What this server's own mirror says, for a listing that would otherwise pay a chain read per
     *  credential. Only as current as the last {@link refresh}; not a substitute for `isRevoked` on
     *  the paths a verifier trusts. */
    isRevokedLocally(commitment: bigint): boolean
}

/**
 * Default backing: `base` stays the source of truth for isRevoked/revoke; the mirror only exists so
 * /v1/revocations/snapshot has a tree to export, and never sees a revoke that failed on `base`.
 * There is no chain, so there is no registry to name either.
 */
export function createInMemoryRevocation(base: Resolver & RevocationWriter): RevocationBacking {
    const mirror = new RevocationRegistry()

    return {
        registryAddress: null,
        registryId: null,
        mirror,
        isApprovedNetworkMember: (id: Hex32) => base.isApprovedNetworkMember(id),
        getCredentialPublicKey: (id: Hex32) => base.getCredentialPublicKey(id),
        async isRevoked(commitment: bigint) {
            return (await base.isRevoked(commitment)) || mirror.isRevoked(commitment)
        },
        isRevokedLocally: (commitment: bigint) => mirror.isRevoked(commitment),
        // No chain, so this mirror is the only tree there is and no other process can move it.
        refresh: async () => {},
        async revoke(commitment: bigint) {
            await base.revoke(commitment)
            mirror.revoke(commitment)
        },
        // No root history without a chain, so only the current one is ever accepted.
        async isValidRoot(root: bigint) {
            return root === mirror.root
        }
    }
}

/**
 * Rebuilds from the chain's physical leaf slots, not events: `unrevoke`/`updateRevocationCommitment`
 * tombstone or rewrite a slot, so an event replay reconstructs the wrong tree once either happened.
 * Count, leaves and root are read at one pinned block so a mid-read write can't mix two states.
 */
export async function rebuildMirror(
    publicClient: Pick<PublicClient, "getBlockNumber" | "readContract">,
    address: Address,
    registryId: bigint
): Promise<RevocationRegistry> {
    // Not the polling-interval-cached read: a re-sync reacting to a just-landed write must not pin
    // to a block from before that write because viem served a stale getBlockNumber from its cache.
    const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 })
    const leafCount = await publicClient.readContract({
        address,
        abi: REVOCATION_ABI,
        functionName: "getRevocationTreeLeafCount",
        args: [registryId],
        blockNumber
    })

    const leaves = await Promise.all(
        Array.from({ length: Number(leafCount) }, (_, index) =>
            publicClient.readContract({
                address,
                abi: REVOCATION_ABI,
                functionName: "getLeaf",
                args: [registryId, BigInt(index)],
                blockNumber
            })
        )
    )
    const mirror = RevocationRegistry.fromLeaves(leaves.map(([value, nextValue]) => ({ value, nextValue })))

    const chainRoot = await publicClient.readContract({
        address,
        abi: REVOCATION_ABI,
        functionName: "getRevocationRoot",
        args: [registryId],
        blockNumber
    })
    assert.equal(
        chainRoot,
        mirror.root,
        `rebuilt revocation mirror root for registry ${registryId} does not match the chain's at block ${blockNumber}`
    )

    return mirror
}

/** The chain calls a serialized `revoke` needs, kept independent of viem's client types so fakes can drive it in tests. */
export interface RevokeChainOps {
    /** The membership proof authorising this revocation. Called once per commitment, not once per
     *  attempt: the message binds the commitment but not the predecessor index. */
    proveRevocation(commitment: bigint): Promise<NetworkMemberProof>
    submitRevoke(commitment: bigint, lowLeafIndex: bigint, proof: NetworkMemberProof): Promise<Hex>
    waitForReceipt(hash: Hex): Promise<{ status: "success" | "reverted" }>
    getRevocationRoot(): Promise<bigint>
    /** Rebuilds the mirror straight from the chain's own leaves, discarding whatever the mirror
     *  currently holds. Used to re-sync after `revoke` can no longer trust its optimistic update. */
    rebuildMirror(): Promise<RevocationRegistry>
}

/**
 * Serializes revokes so each low-leaf index is computed against the previous call's result, and
 * applies a revocation to the mirror only after the transaction succeeded. Any failure re-syncs the
 * mirror from chain before propagating: a stale mirror would poison every later low-leaf index.
 *
 * The queue handles this server's own concurrency. The retry around each attempt handles the other
 * half: the tree is the whole network's, so a foreign member can land a write between computing an
 * index here and submitting it. That is safe to retry with the same proof because the reverted call
 * takes Semaphore's nullifier write with it, and because the index was never bound into the message.
 */
export interface SerializedRevocation {
    revoke(commitment: bigint): Promise<void>
    /** See {@link RevocationBacking.refresh}. Reads the root first, so catching up with a network
     *  that has not moved costs one call and no rebuild. */
    refresh(): Promise<void>
}

export function createSerializedRevoke(mirror: RevocationRegistry, ops: RevokeChainOps): SerializedRevocation {
    let queue: Promise<void> = Promise.resolve()

    const resync = async (): Promise<void> => {
        const rebuilt = await ops.rebuildMirror()
        // In place, not a reassignment: `mirror` is the same object /v1/revocations/snapshot and
        // this closure's own next call already hold a reference to.
        mirror.leanIMTPlus = rebuilt.leanIMTPlus
    }

    const attemptRevoke = async (commitment: bigint, proof: NetworkMemberProof): Promise<void> => {
        const lowLeafIndex = BigInt(mirror.lowLeafIndexOf(commitment))
        const hash = await ops.submitRevoke(commitment, lowLeafIndex, proof)
        const receipt = await ops.waitForReceipt(hash)
        if (receipt.status !== "success") {
            throw new Error(`revoke transaction ${hash} reverted`)
        }

        mirror.revoke(commitment)
        const root = await ops.getRevocationRoot()
        if (root !== mirror.root) {
            throw new Error("on-chain and mirrored revocation roots differ")
        }
    }

    const doRevoke = async (commitment: bigint): Promise<void> => {
        const proof = await ops.proveRevocation(commitment)

        for (let attempt = 1; ; attempt += 1) {
            try {
                await attemptRevoke(commitment, proof)
                return
            } catch (error) {
                // Any failure here — a stale lowLeafIndex, submitRevoke/estimateGas rejecting
                // because another member landed first, a reverted receipt, or the post-write root
                // check itself — can mean the mirror no longer matches the chain, so every path
                // re-syncs before retrying or giving up. Never in place of the original error: a
                // caller needs to see why its own revoke failed, so a resync failure is attached as
                // `cause`, not thrown instead, and ends the attempts — a recomputed index off a
                // mirror that could not be refreshed would be just as stale.
                try {
                    await resync()
                } catch (resyncError) {
                    if (error instanceof Error) {
                        // Not `error.cause = resyncError`: this target's lib predates Error.cause.
                        Object.defineProperty(error, "cause", {
                            value: resyncError,
                            writable: true,
                            configurable: true
                        })
                    } else {
                        console.error("revocation mirror re-sync also failed", resyncError)
                    }
                    throw error
                }
                // The re-synced mirror comes from the chain, so the commitment being in it means
                // this write landed and something else moved the root between the write and the
                // read. Retrying would ask for a predecessor index the commitment no longer needs.
                if (mirror.isRevoked(commitment)) return
                if (attempt === REVOKE_ATTEMPTS) throw error
            }
        }
    }

    const doRefresh = async (): Promise<void> => {
        if ((await ops.getRevocationRoot()) === mirror.root) return
        await resync()
    }

    // Both entry points share the queue: a refresh landing between a write and its post-write root
    // check would rebuild the mirror under it, and that check would then fail against a tree it
    // never wrote.
    const enqueue = (run: () => Promise<void>): Promise<void> => {
        const result = queue.then(run)
        // Chains the next call onto this one regardless of outcome, without making a failed revoke
        // propagate as an unhandled rejection through the queue itself; callers still see `result` reject.
        queue = result.catch(() => {})
        return result
    }

    return {
        revoke: (commitment: bigint) => enqueue(() => doRevoke(commitment)),
        refresh: () => enqueue(doRefresh)
    }
}

/** Where the registry sits and what it points at, all read off the registry contract itself so the
 *  service is configured with one address instead of an address plus a registry id to keep in sync. */
interface RevocationDeployment {
    chain: Chain
    publicClient: PublicClient
    registry: RegistryLocation
    revocationAddress: Address
    registryId: bigint
}

async function connectRevocationChain(address: Address, rpcUrl: string): Promise<RevocationDeployment> {
    const publicClient = createPublicClient({ transport: http(rpcUrl) })
    const chainId = await publicClient.getChainId()
    const chain = defineChain({
        id: chainId,
        name: "issuer-service-revocation-chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
    })

    const [revocationAddress, registryId] = await Promise.all([
        publicClient.readContract({ address, abi: CREDENTIAL_REVOCATION_REGISTRY_ABI, functionName: "REVOCATION" }),
        publicClient.readContract({ address, abi: CREDENTIAL_REVOCATION_REGISTRY_ABI, functionName: "REGISTRY_ID" })
    ])

    return { chain, publicClient, registry: { chainId: BigInt(chainId), address }, revocationAddress, registryId }
}

/** The approved-member group the registry gates on, mirrored from the Semaphore deployment and
 *  group id it exposes. The same group registration proves against, reached the same way. */
export async function mirrorMemberGroup(
    { publicClient, registry }: Pick<RevocationDeployment, "publicClient" | "registry">,
    memberGroupFromBlock: number,
    logWindowBlocks?: number
): Promise<SemaphoreGroupClient> {
    const [semaphoreAddress, groupId] = await Promise.all([
        publicClient.readContract({
            address: registry.address,
            abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
            functionName: "SEMAPHORE"
        }),
        publicClient.readContract({
            address: registry.address,
            abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
            functionName: "NETWORK_MEMBER_GROUP_ID"
        })
    ])
    return new SemaphoreGroupClient(semaphoreAddress, groupId, withLogWindow(publicClient, logWindowBlocks), {
        fromBlock: BigInt(memberGroupFromBlock)
    })
}

/**
 * The half both transports share: the mirror, the chain reads a verifier trusts, and a serialized
 * `revoke` that proves once and then submits through `writer`.
 */
async function assembleBacking(
    deployment: RevocationDeployment,
    base: ApprovalDelegate,
    prover: RevocationProver,
    writer: RevocationRegistryWriter
): Promise<RevocationBacking> {
    const { publicClient, registry, revocationAddress, registryId } = deployment
    const rebuild = () => rebuildMirror(publicClient, revocationAddress, registryId)
    const mirror = await rebuild()

    const { revoke, refresh } = createSerializedRevoke(mirror, {
        proveRevocation: (commitment) =>
            prover.prove({ action: RevocationAction.Revoke, revocationCommitment: commitment }),
        submitRevoke: async (commitment, lowLeafIndex, proof) =>
            (await writer.revoke(commitment, lowLeafIndex, proof)).txHash,
        waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash }),
        getRevocationRoot: () =>
            publicClient.readContract({
                address: revocationAddress,
                abi: REVOCATION_ABI,
                functionName: "getRevocationRoot",
                args: [registryId]
            }),
        rebuildMirror: rebuild
    })

    return {
        registryAddress: revocationAddress,
        registryId,
        mirror,
        isApprovedNetworkMember: (id: Hex32) => base.isApprovedNetworkMember(id),
        getCredentialPublicKey: (id: Hex32) => base.getCredentialPublicKey(id),
        async isRevoked(commitment: bigint) {
            return publicClient.readContract({
                address: revocationAddress,
                abi: REVOCATION_ABI,
                functionName: "isRevoked",
                args: [registryId, commitment]
            })
        },
        isRevokedLocally: (commitment: bigint) => mirror.isRevoked(commitment),
        refresh,
        revoke,
        async isValidRoot(root: bigint) {
            return publicClient.readContract({
                address: registry.address,
                abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
                functionName: "isValidRoot",
                args: [root]
            })
        }
    }
}

export type DirectRevocationConfig = NonNullable<Config["revocation"]> & { memberPrivateKey: `0x${string}` }

/**
 * Chain-backed backing over a plain EOA, for a member server running without an
 * account-abstraction stack. The submitting address is on chain, so it says which org revoked;
 * {@link buildSponsoredRevocation} is what keeps that unattributable. The member proof is required
 * either way — the registry has no address-authorised path.
 */
export async function buildChainRevocation(
    revocation: DirectRevocationConfig,
    rpcUrl: string,
    base: ApprovalDelegate
): Promise<RevocationBacking> {
    const { address, memberIdentitySecret, memberPrivateKey, memberGroupFromBlock, logWindowBlocks } = revocation
    const deployment = await connectRevocationChain(address, rpcUrl)
    const walletClient = createWalletClient({
        account: privateKeyToAccount(memberPrivateKey, { nonceManager }),
        chain: deployment.chain,
        transport: http(rpcUrl)
    })
    const groupMirror = await mirrorMemberGroup(deployment, memberGroupFromBlock, logWindowBlocks)
    const prover = new SemaphoreRevocationProver({
        identity: new Identity(memberIdentitySecret),
        groupMirror,
        registry: deployment.registry
    })

    return assembleBacking(deployment, base, prover, new DirectRevocationWriter(deployment.registry, walletClient))
}

export type SponsoredRevocationBackingConfig = NonNullable<Config["revocation"]> & {
    sponsored: SponsoredConfig
}

/**
 * Chain-backed backing that relays each revoke through a fresh disposable sender under the
 * paymaster, so nothing on chain says which member revoked which credential. Each attempt derives
 * its own sender, which is why a retry needs no new nonce handling.
 */
export async function buildSponsoredRevocation(
    revocation: SponsoredRevocationBackingConfig,
    rpcUrl: string,
    base: ApprovalDelegate
): Promise<RevocationBacking> {
    const { address, memberIdentitySecret, memberGroupFromBlock, logWindowBlocks, sponsored } = revocation
    const deployment = await connectRevocationChain(address, rpcUrl)
    const identity = new Identity(memberIdentitySecret)
    const [groupMirror, relayParams] = await Promise.all([
        mirrorMemberGroup(deployment, memberGroupFromBlock, logWindowBlocks),
        connectSponsoredStack({
            sponsored,
            chainId: Number(deployment.registry.chainId),
            identity,
            publicClient: deployment.publicClient
        })
    ])
    const prover = new SemaphoreRevocationProver({ identity, groupMirror, registry: deployment.registry })
    const relay = new SponsoredRelay(relayParams)

    return assembleBacking(deployment, base, prover, new SponsoredRevocationWriter(deployment.registry, relay))
}
