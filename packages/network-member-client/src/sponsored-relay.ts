import { encodeAbiParameters, encodeFunctionData } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import { entryPoint08Abi, getUserOperationHash } from "viem/account-abstraction"
import { privateKeyToAccount } from "viem/accounts"
import { buildAnnouncement, generateStealthPrivateKey } from "@coordination-network/identity"
import { generateProof } from "@semaphore-protocol/proof"
import type { Identity } from "@semaphore-protocol/identity"
import type { GroupMirror, Sponsorship } from "./types"
import type { SponsoredUserOperation, UserOperationReceipt, UserOperationSubmitter } from "./user-operation"

const SIMPLE_7702_ACCOUNT_ABI = [
    {
        type: "function",
        name: "execute",
        stateMutability: "nonpayable",
        inputs: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" }
        ],
        outputs: []
    }
] as const

const PAYMASTER_ABI = [
    { type: "function", name: "getDeposit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const

/** `ISemaphore.SemaphoreProof`'s own ABI shape: five scalar words plus eight proof points, matching `SemaphorePaymaster._validatePaymasterUserOp`'s decode. */
const PAYMASTER_PROOF_ABI_PARAMS = [
    { name: "merkleTreeDepth", type: "uint256" },
    { name: "merkleTreeRoot", type: "uint256" },
    { name: "nullifier", type: "uint256" },
    { name: "message", type: "uint256" },
    { name: "scope", type: "uint256" },
    { name: "points", type: "uint256[8]" }
] as const

/**
 * 25% above the worst case measured on Sepolia (Glamsterdam).
 * A revocation into a depth-20 tree.
 * Where the insert adds a new level to the tree and its low leaf shares no path with the new leaf.
 * 6,050,000 + 230,000 + 400,000 + 470,000 = 7,150,000 gas in total
 */
const GAS_LIMITS = {
    callGasLimit: 6_050_000n,
    verificationGasLimit: 230_000n,
    preVerificationGas: 400_000n,
    paymasterVerificationGasLimit: 470_000n,
    paymasterPostOpGasLimit: 0n
} as const

export interface SponsoredMemberKeys {
    /** The member's own long-term meta-stealth address; each call derives a fresh, disposable sender from it. */
    metaStealthAddress: Hex
    spendingPrivateKey: Hex
    viewingPrivateKey: Hex
}

export interface SponsoredRelayParams {
    chainId: number
    entryPoint: Address
    paymaster: Address
    accountImplementation: Address
    memberKeys: SponsoredMemberKeys
    /** The member's own Semaphore identity; must be a leaf of `paymasterGroup`. */
    paymasterIdentity: Identity
    /** The paymaster's own mirrored Semaphore group (its admitted members, not the network's). */
    paymasterGroup: GroupMirror
    submitter: UserOperationSubmitter
    publicClient: Pick<PublicClient, "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract">
}

/** One relayed call's outcome: whatever the EntryPoint reported, plus what the sponsorship cost. */
export interface RelayedCall {
    receipt: UserOperationReceipt
    sponsorship: Sponsorship
}

/** The call to relay. `value` defaults to zero, which is every call this track makes today. */
export interface RelayCall {
    target: Address
    value?: bigint
    data: Hex
}

/**
 * Relays one call through a fresh, disposable stealth sender delegated to Simple7702Account and
 * sponsored by SemaphorePaymaster, so the member pays nothing and no sender links two of the
 * member's relayed calls to each other.
 *
 * A reverted operation comes back as a receipt, not an error: which reverts are worth retrying and
 * which are final depends on the contract being called, so the caller owns that reading.
 */
export class SponsoredRelay {
    private readonly chainId: number
    private readonly entryPoint: Address
    private readonly paymaster: Address
    private readonly accountImplementation: Address
    private readonly memberKeys: SponsoredMemberKeys
    private readonly paymasterIdentity: Identity
    private readonly paymasterGroup: GroupMirror
    private readonly submitter: UserOperationSubmitter
    private readonly publicClient: Pick<
        PublicClient,
        "estimateFeesPerGas" | "getBalance" | "getTransactionCount" | "readContract"
    >

    constructor(params: SponsoredRelayParams) {
        this.chainId = params.chainId
        this.entryPoint = params.entryPoint
        this.paymaster = params.paymaster
        this.accountImplementation = params.accountImplementation
        this.memberKeys = params.memberKeys
        this.paymasterIdentity = params.paymasterIdentity
        this.paymasterGroup = params.paymasterGroup
        this.submitter = params.submitter
        this.publicClient = params.publicClient
    }

    async relay({ target, value = 0n, data }: RelayCall): Promise<RelayedCall> {
        const sender = this.deriveSender()

        const [senderBalanceBefore, paymasterDepositBefore] = await Promise.all([
            this.publicClient.getBalance({ address: sender.address }),
            this.readPaymasterDeposit()
        ])

        const callData = encodeFunctionData({
            abi: SIMPLE_7702_ACCOUNT_ABI,
            functionName: "execute",
            args: [target, value, data]
        })
        const paymasterData = await this.buildPaymasterProof(sender.address)

        const [nonce, transactionCount] = await Promise.all([
            this.publicClient.readContract({
                address: this.entryPoint,
                abi: entryPoint08Abi,
                functionName: "getNonce",
                args: [sender.address, 0n]
            }),
            this.publicClient.getTransactionCount({ address: sender.address })
        ])
        const authorization = await sender.signAuthorization({
            address: this.accountImplementation,
            chainId: this.chainId,
            nonce: transactionCount
        })

        const { maxFeePerGas, maxPriorityFeePerGas } = await this.publicClient.estimateFeesPerGas()
        const unsignedUserOperation: SponsoredUserOperation = {
            sender: sender.address,
            nonce,
            factory: "0x7702",
            callData,
            ...GAS_LIMITS,
            maxFeePerGas,
            maxPriorityFeePerGas,
            paymaster: this.paymaster,
            paymasterData,
            authorization,
            signature: "0x"
        }
        const userOpHash = getUserOperationHash({
            chainId: this.chainId,
            entryPointAddress: this.entryPoint,
            entryPointVersion: "0.8",
            userOperation: unsignedUserOperation
        })
        const signature = await sender.sign({ hash: userOpHash })
        const userOperation: SponsoredUserOperation = { ...unsignedUserOperation, signature }

        const submittedHash = await this.submitter.send(userOperation)
        // A bundler on another EntryPoint (or a bug in this one) would otherwise surface as
        // waitForReceipt timing out on a hash nothing will ever mine.
        if (submittedHash !== userOpHash) {
            throw new Error(`bundler returned userOpHash ${submittedHash}, expected ${userOpHash}`)
        }
        const receipt = await this.submitter.waitForReceipt(userOpHash)

        const [senderBalanceAfter, paymasterDepositAfter] = await Promise.all([
            this.publicClient.getBalance({ address: sender.address }),
            this.readPaymasterDeposit()
        ])

        return {
            receipt,
            sponsorship: {
                sender: sender.address,
                senderBalanceBefore,
                senderBalanceAfter,
                userOpHash,
                bundleTxHash: receipt.transactionHash,
                actualGasCost: receipt.actualGasCost,
                paymaster: this.paymaster,
                paymasterDepositBefore,
                paymasterDepositAfter
            }
        }
    }

    /**
     * A fresh, disposable stealth address derived from the member's own meta-address: used once
     * to sign and pay (nothing, since it's sponsored) for this call, then dropped. No announcement
     * is made, so it can't link two of the member's relayed calls to each other.
     */
    private deriveSender() {
        const announcement = buildAnnouncement({ metaStealthAddress: this.memberKeys.metaStealthAddress })
        const privateKey = generateStealthPrivateKey({
            ephemeralPublicKey: announcement.ephemeralPublicKey,
            viewingPrivateKey: this.memberKeys.viewingPrivateKey,
            spendingPrivateKey: this.memberKeys.spendingPrivateKey
        })
        return privateKeyToAccount(privateKey)
    }

    private readPaymasterDeposit(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.paymaster,
            abi: PAYMASTER_ABI,
            functionName: "getDeposit"
        })
    }

    /** The paymaster's own proof: the member's Semaphore identity against its mirrored group, message and scope both the disposable sender (`SemaphorePaymaster`'s own binding). */
    private async buildPaymasterProof(sender: Address): Promise<Hex> {
        const group = await this.paymasterGroup.currentGroup()
        const senderAsScalar = BigInt(sender)
        const proof = await generateProof(this.paymasterIdentity, group, senderAsScalar, senderAsScalar)

        return encodeAbiParameters(PAYMASTER_PROOF_ABI_PARAMS, [
            BigInt(proof.merkleTreeDepth),
            BigInt(proof.merkleTreeRoot),
            BigInt(proof.nullifier),
            BigInt(proof.message),
            BigInt(proof.scope),
            proof.points.map(BigInt) as unknown as readonly [
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint
            ]
        ])
    }
}
