import { SemaphoreGroupClient } from "@coordination-network/network-member-client"
import { parseAbi } from "viem"
import { EventLogIndex, withLogWindow } from "../../issuer-service/src/chain-logs"
import { Chain } from "./anvil"
import { ContractDeployment } from "./deployer"
import { describeError } from "./redact-urls"

/** Both events move a commitment in or out of `NetworkMemberGroup`; only their order matters here. */
const NETWORK_MEMBER_EVENTS_ABI = parseAbi([
    "event NetworkMemberAdded(uint256 identityCommitment)",
    "event NetworkMemberRemoved(uint256 identityCommitment)"
])
const NETWORK_MEMBER_GROUP_ABI = parseAbi(["function hasNetworkMember(uint256 identityCommitment) view returns (bool)"])

/** The paymaster's own Semaphore surface the mirror uses, for a deployment known only by address. */
export const PAYMASTER_GROUP_ABI = parseAbi([
    "function GROUP_ID() view returns (uint256)",
    "function hasMember(uint256 groupId, uint256 identityCommitment) view returns (bool)",
    "function addMember(uint256 groupId, uint256 identityCommitment)",
    "function removeMember(uint256 groupId, uint256 identityCommitment, uint256[] merkleProofSiblings)"
])

type MirrorChain = Pick<Chain, "chainDefinition" | "publicClient" | "signer" | "walletClient">

export type MirrorChange = "added" | "removed"

export interface PaymasterMirrorOptions {
    /** The first block that can hold a membership log: the member group's deploy block. */
    fromBlock: bigint
    /** Where the paymaster group's own leaves are replayed from, for a removal's Merkle siblings. */
    paymasterGroupFromBlock?: bigint
    logWindowBlocks?: number
    /** Blocks a log is buried under before it is mirrored. */
    logConfirmations?: number
    pollingIntervalMs?: number
    /** How often the logs are read again from `fromBlock`; ten minutes when omitted. */
    rescanIntervalMs?: number
}

const DEFAULT_RESCAN_INTERVAL_MS = 10 * 60 * 1000

/**
 * Brings one commitment's membership in the paymaster group in line with the member group's:
 * `addMember` reverts on a duplicate and `removeMember` on a stranger, so each send is decided by
 * comparing the two, which also makes a restart or a replayed log harmless. Only the commitments the
 * member group has logged are touched, because other code adds its own to the paymaster group.
 */
export function createReconciler(
    chain: MirrorChain,
    paymaster: ContractDeployment,
    group: ContractDeployment,
    { paymasterGroupFromBlock = 0n, logWindowBlocks }: PaymasterMirrorOptions,
    diagnostic: (message: string) => void
): (commitment: bigint) => Promise<MirrorChange | undefined> {
    let groupId: bigint | undefined

    const send = async (functionName: "addMember" | "removeMember", args: readonly unknown[], summary: string) => {
        const hash = await chain.walletClient.writeContract({
            address: paymaster.address,
            abi: paymaster.abi,
            functionName,
            args,
            account: chain.signer,
            chain: chain.chainDefinition
        })
        diagnostic(`${summary}: sent ${hash}`)
        const receipt = await chain.publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status === "reverted") throw new Error(`${summary} reverted: ${hash}`)
    }

    return async (commitment) => {
        groupId ??= (await chain.publicClient.readContract({
            address: paymaster.address,
            abi: paymaster.abi,
            functionName: "GROUP_ID"
        })) as bigint
        const id = groupId
        const [inMemberGroup, inPaymaster] = await Promise.all([
            chain.publicClient.readContract({
                address: group.address,
                abi: NETWORK_MEMBER_GROUP_ABI,
                functionName: "hasNetworkMember",
                args: [commitment]
            }),
            chain.publicClient.readContract({
                address: paymaster.address,
                abi: paymaster.abi,
                functionName: "hasMember",
                args: [id, commitment]
            }) as Promise<boolean>
        ])
        if (inMemberGroup === inPaymaster) return undefined

        if (inMemberGroup) {
            await send("addMember", [id, commitment], `mirror commitment ${commitment} into the paymaster group`)
            diagnostic(`Mirrored commitment ${commitment} into the paymaster group`)
            return "added"
        }
        const paymasterGroup = await new SemaphoreGroupClient(
            paymaster.address,
            id,
            withLogWindow(chain.publicClient, logWindowBlocks),
            { fromBlock: paymasterGroupFromBlock }
        ).currentGroup()
        const { siblings } = paymasterGroup.generateMerkleProof(paymasterGroup.indexOf(commitment))
        await send(
            "removeMember",
            [id, commitment, siblings],
            `remove commitment ${commitment} from the paymaster group`
        )
        diagnostic(`Removed commitment ${commitment} from the paymaster group`)
        return "removed"
    }
}

/** Every membership log of the member group, in chain order, from its deploy block. */
function memberLogIndex(chain: MirrorChain, group: ContractDeployment, options: PaymasterMirrorOptions) {
    const { fromBlock, logWindowBlocks, logConfirmations } = options
    return new EventLogIndex({
        fromBlock,
        windowBlocks: logWindowBlocks === undefined ? undefined : BigInt(logWindowBlocks),
        confirmations: logConfirmations === undefined ? undefined : BigInt(logConfirmations),
        fetch: (from, to) =>
            chain.publicClient.getLogs({
                address: group.address,
                events: NETWORK_MEMBER_EVENTS_ABI,
                fromBlock: from,
                toBlock: to,
                strict: true
            })
    })
}

/**
 * Keeps the paymaster's own Semaphore group in step with the approved-member group, so a member's
 * sponsored user operations can prove membership against it. The paymaster admits nobody itself:
 * the stack, as the paymaster's group admin, mirrors every member the governance group admits or removes.
 *
 * Membership is read as logs from `fromBlock`, not through a filter: viem drops a filter's poll
 * errors and re-creates a lost filter from the head, which would skip a change in the gap.
 */
export async function mirrorMembersIntoPaymaster(
    chain: Chain,
    paymaster: ContractDeployment,
    group: ContractDeployment,
    diagnostic: (message: string) => void = () => {},
    onMirrored: (commitment: bigint, change: MirrorChange) => void = () => {},
    onMirrorFailed: (commitment: bigint, error: unknown) => void = () => {},
    options: PaymasterMirrorOptions = { fromBlock: 0n }
): Promise<() => void> {
    const reconcile = createReconciler(chain, paymaster, group, options, diagnostic)
    // The index never goes back, and a provider lagging beyond the confirmations can leave it past
    // blocks it never served. Replays send nothing: the reconciler compares both groups first.
    let memberLogs = memberLogIndex(chain, group, options)
    const pollingIntervalMs = options.pollingIntervalMs ?? 1000
    const pollsPerRescan = Math.ceil((options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS) / pollingIntervalMs)
    let pollsSinceRescan = 0

    // One at a time: a failed send would otherwise leave the next one stuck behind a nonce gap.
    let queue: Promise<void> = Promise.resolve()
    let enqueued = 0
    const failed = new Set<bigint>()
    const enqueue = (commitment: bigint) => {
        // A failed mirror is reported, not thrown: the poll loop and the stack outlive it.
        queue = queue
            .then(async () => {
                const change = await reconcile(commitment)
                failed.delete(commitment)
                if (change !== undefined) onMirrored(commitment, change)
            })
            .catch((error: unknown) => {
                failed.add(commitment)
                diagnostic(
                    `Failed to mirror commitment ${commitment} into the paymaster group: ${describeError(error)}`
                )
                onMirrorFailed(commitment, error)
            })
    }
    const poll = async () => {
        pollsSinceRescan += 1
        if (pollsSinceRescan >= pollsPerRescan) {
            pollsSinceRescan = 0
            memberLogs = memberLogIndex(chain, group, options)
            enqueued = 0
        }
        const retries = [...failed]
        const logs = await memberLogs.sync(await chain.publicClient.getBlockNumber({ cacheTime: 0 }))
        for (const commitment of retries) enqueue(commitment)
        for (; enqueued < logs.length; enqueued++) enqueue(logs[enqueued].args.identityCommitment)
    }

    let stopped = false
    let timer: NodeJS.Timeout | undefined
    const tick = async () => {
        try {
            await poll()
        } catch (error) {
            diagnostic(`Failed to read paymaster group membership: ${describeError(error)}`)
        }
        if (!stopped) timer = setTimeout(() => void tick(), pollingIntervalMs)
    }
    // Caught up before returning, so a change from before this run is mirrored before the stack serves.
    await tick()
    await queue

    return () => {
        stopped = true
        clearTimeout(timer)
    }
}

/** One pass of the mirror, for genesis: every commitment the member group has logged is reconciled
 *  in chain order, and a failed send stops it. Resolves to what it changed. */
export async function reconcilePaymasterGroup(
    chain: Chain,
    paymaster: ContractDeployment,
    group: ContractDeployment,
    options: PaymasterMirrorOptions,
    diagnostic: (message: string) => void = () => {},
    /** Commitments the caller already reconciled, which a lagging read must not send twice. */
    skip: ReadonlySet<bigint> = new Set()
): Promise<{ commitment: bigint; change: MirrorChange }[]> {
    const reconcile = createReconciler(chain, paymaster, group, options, diagnostic)
    const logs = await memberLogIndex(chain, group, options).sync(
        await chain.publicClient.getBlockNumber({ cacheTime: 0 })
    )

    const changes: { commitment: bigint; change: MirrorChange }[] = []
    for (const { args } of logs) {
        if (skip.has(args.identityCommitment)) continue
        const change = await reconcile(args.identityCommitment)
        if (change !== undefined) changes.push({ commitment: args.identityCommitment, change })
    }
    return changes
}
