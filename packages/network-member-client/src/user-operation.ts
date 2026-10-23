import { encodeFunctionData, http, parseEventLogs } from "viem"
import type {
    Account,
    Address,
    Chain,
    Hex,
    PublicClient,
    SignedAuthorization,
    Transport,
    TransactionReceipt,
    WalletClient
} from "viem"
import {
    createBundlerClient,
    entryPoint08Abi,
    formatUserOperationRequest,
    getUserOperationHash,
    toPackedUserOperation
} from "viem/account-abstraction"

/**
 * A fully assembled ERC-4337 v0.8 user operation for a 7702-delegated, paymaster-sponsored call.
 * Every gas and paymaster field is required, never left to a bundler default: `factory` is always
 * the 7702 marker and `authorization` is always present, since this track has no other kind of op.
 */
export interface SponsoredUserOperation {
    sender: Address
    nonce: bigint
    factory: "0x7702"
    callData: Hex
    callGasLimit: bigint
    verificationGasLimit: bigint
    preVerificationGas: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    paymaster: Address
    paymasterVerificationGasLimit: bigint
    paymasterPostOpGasLimit: bigint
    paymasterData: Hex
    authorization: SignedAuthorization
    signature: Hex
}

/** One submitted user operation's outcome, parsed from the EntryPoint's own events so both submitters report the same shape. */
export interface UserOperationReceipt {
    transactionHash: Hex
    success: boolean
    actualGasCost: bigint
    actualGasUsed: bigint
    /** Raw `UserOperationRevertReason` data, present only when `success` is false. */
    revertReason?: Hex
}

/** Submits a signed user operation and waits for its outcome. `waitForReceipt` takes the hash `send` returns. */
export interface UserOperationSubmitter {
    send(userOperation: SponsoredUserOperation): Promise<Hex>
    waitForReceipt(userOpHash: Hex): Promise<UserOperationReceipt>
}

/** Decodes `UserOperationEvent`/`UserOperationRevertReason` for one userOpHash out of a mined transaction's logs. */
export function parseUserOperationReceipt(
    transactionReceipt: TransactionReceipt,
    entryPointAbi: typeof entryPoint08Abi,
    userOpHash: Hex
): UserOperationReceipt {
    const operationEvent = parseEventLogs({
        abi: entryPointAbi,
        eventName: "UserOperationEvent",
        logs: transactionReceipt.logs
    }).find((event) => event.args.userOpHash === userOpHash)
    if (!operationEvent) {
        throw new Error(`no UserOperationEvent for ${userOpHash} in transaction ${transactionReceipt.transactionHash}`)
    }

    const revertEvent = parseEventLogs({
        abi: entryPointAbi,
        eventName: "UserOperationRevertReason",
        logs: transactionReceipt.logs
    }).find((event) => event.args.userOpHash === userOpHash)

    return {
        transactionHash: transactionReceipt.transactionHash,
        success: operationEvent.args.success,
        actualGasCost: operationEvent.args.actualGasCost,
        actualGasUsed: operationEvent.args.actualGasUsed,
        revertReason: revertEvent?.args.revertReason
    }
}

/** Submits to a bundler's JSON-RPC (`eth_sendUserOperation`/`eth_getUserOperationReceipt`), for the member server. */
export class BundlerRpcSubmitter implements UserOperationSubmitter {
    private readonly client: ReturnType<typeof createBundlerClient>

    constructor(
        url: string,
        private readonly entryPoint: Address
    ) {
        this.client = createBundlerClient({ transport: http(url) })
    }

    async send(userOperation: SponsoredUserOperation): Promise<Hex> {
        return this.client.request({
            method: "eth_sendUserOperation",
            params: [formatUserOperationRequest(userOperation), this.entryPoint]
        })
    }

    async waitForReceipt(userOpHash: Hex): Promise<UserOperationReceipt> {
        const receipt = await this.client.waitForUserOperationReceipt({ hash: userOpHash })
        return parseUserOperationReceipt(receipt.receipt, entryPoint08Abi, userOpHash)
    }
}

type EntryPointChainClient = Pick<WalletClient<Transport, Chain, Account>, "account" | "chain" | "sendTransaction"> &
    Pick<PublicClient, "waitForTransactionReceipt">

/**
 * Submits straight to the EntryPoint's `handleOps`, for the stack bundler and the integration
 * test: no mempool, one operation per call, the beneficiary is the submitting account itself.
 */
export class EntryPointSubmitter implements UserOperationSubmitter {
    private readonly transactionHashes = new Map<Hex, Hex>()

    constructor(
        private readonly client: EntryPointChainClient,
        private readonly entryPoint: Address
    ) {}

    async send(userOperation: SponsoredUserOperation): Promise<Hex> {
        const userOpHash = getUserOperationHash({
            chainId: this.client.chain.id,
            entryPointAddress: this.entryPoint,
            entryPointVersion: "0.8",
            userOperation
        })
        const data = encodeFunctionData({
            abi: entryPoint08Abi,
            functionName: "handleOps",
            args: [[toPackedUserOperation(userOperation)], this.client.account.address]
        })
        const transactionHash = await this.client.sendTransaction({
            account: this.client.account,
            chain: this.client.chain,
            to: this.entryPoint,
            data,
            authorizationList: [userOperation.authorization]
        })

        // waitForReceipt only gets the userOpHash back, so the mapping to the transaction that
        // carried it has to live here.
        this.transactionHashes.set(userOpHash, transactionHash)
        return userOpHash
    }

    async waitForReceipt(userOpHash: Hex): Promise<UserOperationReceipt> {
        const transactionHash = this.transactionHashes.get(userOpHash)
        if (transactionHash === undefined) throw new Error(`no transaction sent for user operation ${userOpHash}`)

        const transactionReceipt = await this.client.waitForTransactionReceipt({ hash: transactionHash })
        return parseUserOperationReceipt(transactionReceipt, entryPoint08Abi, userOpHash)
    }
}
