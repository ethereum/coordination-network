import type { MetaTransactionData, SafeTransactionData } from "@safe-global/types-kit"
import { getAddress, type Address, type Hex } from "viem"
import type { HDAccount } from "viem/accounts"
import {
    buildSafeTransactionData,
    checkQuorum,
    encodeApproveHash,
    encodeExecTransaction,
    hashSafeTransaction,
    onChainApproval,
    type SafeContext
} from "@coordination-network/network-member-governance"
import { SAFE_ABI } from "./abis.ts"
import { publicClient, send } from "./config.ts"

/** The Safe's live governance state, which every transaction is built against. */
export interface SafeState {
    nonce: number
    owners: Address[]
    threshold: number
}

export async function readSafeState(safe: Address): Promise<SafeState> {
    const [nonce, owners, threshold] = await Promise.all([
        publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" }),
        publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
        publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" })
    ])

    return { nonce: Number(nonce), owners: [...owners], threshold: Number(threshold) }
}

/**
 * Builds a Safe transaction against the Safe's current nonce: one plain call, or several batched
 * through MultiSendCallOnly so they land together.
 *
 * For the deployment-time calls only. Admissions and removals use the governance package's own
 * builders, so the demo takes the path a member server takes.
 */
export async function buildSafeCall(
    context: SafeContext,
    calls: MetaTransactionData | MetaTransactionData[]
): Promise<SafeTransactionData> {
    const { nonce } = await readSafeState(context.safeAddress)

    return buildSafeTransactionData([calls].flat(), context, nonce)
}

/**
 * Approves a Safe transaction on chain as each owner in turn, then executes it as the last one.
 *
 * Condensed into one function because the demo plays every member itself. In production each approver
 * runs this independently, deriving the same hash from the same chain state so their `approveHash`
 * calls accumulate against it. The Safe counts the executor as an approver, so a quorum of n means
 * n - 1 approvals plus the execution.
 *
 * @param approvers The owners approving, the last of which executes. Must reach the threshold.
 */
export async function approveAndExecute(
    context: SafeContext,
    transaction: SafeTransactionData,
    approvers: HDAccount[]
) {
    const safeAddress = getAddress(context.safeAddress)
    const { owners, threshold } = await readSafeState(safeAddress)
    const slots = approvers.map((approver) => getAddress(approver.address))

    const quorum = checkQuorum(owners, threshold, slots)
    if (!quorum.hasQuorum) {
        throw new Error(`${slots.length} approvers is short of the Safe's threshold of ${threshold}`)
    }

    const safeTxHash = hashSafeTransaction(context, transaction)

    // The digest the package derives must be the one the Safe checks. Comparing them here turns a
    // version or encoding mismatch into a clear failure rather than an unexplained GS026 at execution.
    const onChainHash = await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_ABI,
        functionName: "getTransactionHash",
        args: [
            transaction.to as Address,
            BigInt(transaction.value),
            transaction.data as Hex,
            transaction.operation ?? 0,
            BigInt(transaction.safeTxGas),
            BigInt(transaction.baseGas),
            BigInt(transaction.gasPrice),
            transaction.gasToken as Address,
            transaction.refundReceiver as Address,
            BigInt(transaction.nonce)
        ]
    })
    if (onChainHash !== safeTxHash) {
        throw new Error(`safeTxHash ${safeTxHash} does not match the Safe's own ${onChainHash}`)
    }

    // Every approver but the last records its approval from its own key.
    const executor = approvers[approvers.length - 1]
    for (const approver of approvers.slice(0, -1)) {
        await send({ account: approver, to: safeAddress, data: encodeApproveHash(context, safeTxHash) })
    }

    // The last one submits, and the Safe counts it as the final approval.
    return send({
        account: executor,
        to: safeAddress,
        data: encodeExecTransaction(context, transaction, slots.map(onChainApproval))
    })
}
