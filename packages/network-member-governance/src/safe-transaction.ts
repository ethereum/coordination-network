import {
    DEFAULT_SAFE_VERSION,
    EthSafeSignature,
    buildSignatureBytes,
    calculateSafeTransactionHash,
    encodeMultiSendData,
    generatePreValidatedSignature,
    generateTypedData
} from "@safe-global/protocol-kit"
import { getMultiSendCallOnlyDeployment, getSafeSingletonDeployment } from "@safe-global/safe-deployments"
import {
    OperationType,
    type MetaTransactionData,
    type SafeSignature,
    type SafeTransactionData
} from "@safe-global/types-kit"
import {
    encodeFunctionData,
    getAddress,
    isAddressEqual,
    recoverAddress,
    type Abi,
    type Address,
    type Hex,
    type TypedDataDefinition
} from "viem"

import { NO_REFUND } from "./constants"
import type { QuorumCheck, SafeContext } from "./types"

function safeVersionOf(context: SafeContext) {
    return context.safeVersion ?? DEFAULT_SAFE_VERSION
}

function chainIdOf(context: SafeContext) {
    return BigInt(context.chainId)
}

/**
 * The MultiSendCallOnly ABI for this context's Safe version.
 *
 * Deliberately not chain-scoped. Only the address varies by chain, so resolving the ABI separately is
 * what lets {SafeContext.multiSend} work on a chain with no canonical deployment, which is the only
 * situation that override exists for.
 *
 * @param context The Safe version the batch is for.
 * @returns The MultiSendCallOnly ABI.
 */
function multiSendAbi(context: SafeContext): Abi {
    const deployment = getMultiSendCallOnlyDeployment({ version: safeVersionOf(context) })

    if (!deployment) throw new Error(`No MultiSendCallOnly deployment for Safe ${safeVersionOf(context)}`)

    return deployment.abi as Abi
}

/**
 * The canonical MultiSendCallOnly address for this context's chain.
 *
 * @param context The Safe and chain the batch is for.
 * @returns The address, or throws when the chain has no canonical deployment.
 */
function multiSendAddress(context: SafeContext): Address {
    const chainId = chainIdOf(context).toString()
    const deployment = getMultiSendCallOnlyDeployment({ version: safeVersionOf(context), network: chainId })

    if (!deployment?.networkAddresses[chainId]) {
        throw new Error(
            `No canonical MultiSendCallOnly deployment for chain ${chainId} at Safe ${safeVersionOf(context)}. Pass \`multiSend\` explicitly.`
        )
    }

    return getAddress(deployment.networkAddresses[chainId])
}

/**
 * The MultiSendCallOnly the Safe delegate-calls to batch several calls.
 *
 * Resolved from `@safe-global/safe-deployments` for this chain and Safe version,
 * which is what keeps a wrong address out of a delegate call. Override it in the
 * context only for a chain where the canonical deployment is missing.
 *
 * @param context The Safe and chain the batch is for.
 * @returns The MultiSendCallOnly address.
 */
export function resolveMultiSend(context: SafeContext): Address {
    if (context.multiSend) return getAddress(context.multiSend)

    return multiSendAddress(context)
}

/** The Safe singleton ABI for this context's version, from the Safe deployments. */
function safeAbi(context: SafeContext): Abi {
    const deployment = getSafeSingletonDeployment({ version: safeVersionOf(context) })

    if (!deployment) throw new Error(`No Safe singleton deployment for version ${safeVersionOf(context)}`)

    return deployment.abi as Abi
}

/**
 * Builds the Safe transaction data for one or more calls, with the gas and refund
 * fields zeroed so whoever submits it pays.
 *
 * A single call is executed directly. Several calls are batched through
 * MultiSendCallOnly as one delegate call, so the Safe applies them together or
 * not at all.
 *
 * @param transactions The calls, in the order the Safe should make them.
 * @param context The Safe and chain the transaction is for.
 * @param nonce The Safe's current `nonce()`. Read it from the chain: a
 * transaction built against a stale nonce is rejected, and executing any Safe
 * transaction invalidates every approval recorded against that nonce.
 * @returns The transaction data to hash and sign.
 */
export function buildSafeTransactionData(
    transactions: MetaTransactionData[],
    context: SafeContext,
    nonce: number
): SafeTransactionData {
    if (transactions.length === 0) throw new Error("A Safe transaction needs at least one call")

    if (transactions.length === 1) {
        const [transaction] = transactions

        return {
            to: getAddress(transaction.to as Address),
            value: transaction.value,
            data: transaction.data,
            operation: transaction.operation ?? OperationType.Call,
            ...NO_REFUND,
            nonce
        }
    }

    // `encodeMultiSendData` packs the calls; MultiSendCallOnly still has to be
    // called through its own `multiSend` entry point.
    const packedCalls = encodeMultiSendData(
        transactions.map((transaction) => ({
            ...transaction,
            operation: transaction.operation ?? OperationType.Call
        }))
    ) as Hex

    return {
        to: resolveMultiSend(context),
        value: "0",
        data: encodeFunctionData({
            abi: multiSendAbi(context),
            functionName: "multiSend",
            args: [packedCalls]
        }),
        operation: OperationType.DelegateCall,
        ...NO_REFUND,
        nonce
    }
}

/**
 * The digest the Safe's owners sign, as the Safe's own `getTransactionHash`
 * computes it. Bound to the Safe and the chain by the EIP-712 domain, so a
 * signature cannot be replayed against another Safe or another network.
 *
 * @param context The Safe and chain the transaction is for.
 * @param transaction The transaction data to hash.
 * @returns The EIP-712 digest.
 */
export function hashSafeTransaction(context: SafeContext, transaction: SafeTransactionData): Hex {
    return calculateSafeTransactionHash(
        getAddress(context.safeAddress),
        transaction,
        safeVersionOf(context),
        chainIdOf(context)
    ) as Hex
}

/** What a member server needs from its governance key: EIP-712 signing. */
export interface TypedDataSigner {
    /** The owner address this key signs for. */
    address: Address
    /** Signs EIP-712 typed data, returning a 65-byte signature. */
    signTypedData(typedData: TypedDataDefinition): Promise<Hex>
}

/**
 * Signs a Safe transaction as one approver.
 *
 * Governance approves on chain with {encodeApproveHash} and never circulates a
 * signature, so nothing in this package's flow calls this. It stays as a Safe
 * primitive, and the tests use it to check the packing in
 * {encodeSafeSignatures}.
 *
 * The signer must be an owner of the Safe. A viem account works directly, and so
 * does any wrapper over a KMS or HSM that signs EIP-712 and knows its address.
 *
 * @param signer The approver's signing key.
 * @param context The Safe and chain the transaction is for.
 * @param transaction The transaction to approve.
 * @returns The approver's signature.
 */
export async function signSafeTransaction(
    signer: TypedDataSigner,
    context: SafeContext,
    transaction: SafeTransactionData
): Promise<SafeSignature> {
    const typedData = generateTypedData({
        safeAddress: getAddress(context.safeAddress),
        safeVersion: safeVersionOf(context),
        chainId: chainIdOf(context),
        data: transaction
    })

    const signature = await signer.signTypedData(typedData as unknown as TypedDataDefinition)

    return new EthSafeSignature(getAddress(signer.address), signature)
}

/**
 * Recovers the owner behind a signature over a Safe transaction, trusting the
 * signature rather than a claimed sender. Like {signSafeTransaction}, it serves
 * off-chain signatures, which this package's flow does not produce.
 *
 * @param context The Safe and chain the transaction is for.
 * @param transaction The signed transaction.
 * @param signature The 65-byte signature.
 * @returns The recovered signer address.
 */
export async function recoverSafeSigner(
    context: SafeContext,
    transaction: SafeTransactionData,
    signature: Hex
): Promise<Address> {
    return recoverAddress({ hash: hashSafeTransaction(context, transaction), signature })
}

/**
 * Calldata for `approveHash`, which records an approval in the Safe's own storage instead of handing a
 * signature to somebody.
 *
 * This is the fully on-chain approval path, and its appeal is that nothing is ever circulated: each
 * approver derives the transaction from the chain, approves its hash from its own key, and the member
 * that completes the quorum reads the approvals and executes. There is no channel to secure, and no
 * approver ever acts on a payload another party assembled, which is what makes blind signing
 * impossible rather than merely detectable.
 *
 * Only an owner may call it, and the hash must be the one from {hashSafeTransaction}: an approval is
 * bound to one exact transaction, so approving one candidate's admission says nothing about another's.
 *
 * @param context The Safe and chain the transaction is for.
 * @param safeTxHash The digest from {hashSafeTransaction}.
 * @returns Calldata to send to the Safe address, from the approver's own key.
 */
export function encodeApproveHash(context: SafeContext, safeTxHash: Hex): Hex {
    return encodeFunctionData({
        abi: safeAbi(context),
        functionName: "approveHash",
        args: [safeTxHash]
    })
}

/**
 * The signature entry for an owner that approved on chain with {encodeApproveHash}.
 *
 * It carries no signature material: the Safe reads `v == 1` and looks the approval up in its own
 * storage, so the entry only names the approver. Feed these to {encodeSafeSignatures} or
 * {encodeExecTransaction} exactly like signatures made off chain, and the two kinds may be mixed in one
 * transaction.
 *
 * The member that submits gets its own entry for free: the Safe treats the executor as having approved,
 * so it can include itself without a prior `approveHash`, turning a 3-of-5 into two approval
 * transactions plus the execution.
 *
 * @param owner The approver, which must still be an owner when the transaction executes.
 * @returns A signature entry naming that approver.
 */
export function onChainApproval(owner: Address): SafeSignature {
    return generatePreValidatedSignature(getAddress(owner))
}

/**
 * Packs signatures into the `signatures` argument of `execTransaction`.
 *
 * The Safe reads the packed signatures at fixed 65-byte offsets and requires each recovered signer to be
 * strictly greater than the previous one, so the SDK sorts them by signer here.
 * A set that counts the same owner twice would sort fine and then be rejected on
 * chain, so it is refused up front.
 *
 * @param signatures The approvals, in any order. {onChainApproval} produces them for the on-chain
 * flow.
 * @returns The entries concatenated into the single `bytes` value `execTransaction` takes, 65 bytes
 * per owner, ordered by signer.
 */
export function encodeSafeSignatures(signatures: SafeSignature[]): Hex {
    if (signatures.length === 0) throw new Error("A Safe transaction needs at least one signature")

    const seen = new Set<string>()
    signatures.forEach(({ signer }) => {
        const owner = getAddress(signer as Address)
        if (seen.has(owner)) throw new Error(`Duplicate signature from ${owner}: the Safe counts each owner once`)
        seen.add(owner)
    })

    return buildSignatureBytes([...signatures]) as Hex
}

/**
 * Checks a set of approvers against the Safe's owners and threshold, so a member
 * knows whether it can submit yet and, if not, how many approvals are missing.
 * Addresses that are not current owners are ignored rather than counted.
 *
 * @param owners The Safe's current owners, from `getOwners()`.
 * @param threshold The Safe's current `getThreshold()`.
 * @param signers The addresses that have approved, read from the chain.
 * @returns Whether the set is enough, and what is still missing.
 */
export function checkQuorum(owners: Address[], threshold: number, signers: Address[]): QuorumCheck {
    const isOwner = (candidate: Address) => owners.some((owner) => isAddressEqual(owner, candidate))
    const distinct = [...new Set(signers.filter(isOwner).map((signer) => getAddress(signer)))].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1
    )

    return {
        hasQuorum: distinct.length >= threshold,
        signers: distinct,
        missing: Math.max(threshold - distinct.length, 0)
    }
}

/**
 * Encodes the `execTransaction` call that lands the transaction on chain, against
 * the Safe ABI for this context's version. The result is plain calldata to the
 * Safe, so anyone can submit it: the approvals carry the authority, not the
 * sender.
 *
 * @param context The Safe and chain the transaction is for.
 * @param transaction The approved transaction.
 * @param signatures The approvals, in any order.
 * @returns Calldata to send to the Safe address.
 */
export function encodeExecTransaction(
    context: SafeContext,
    transaction: SafeTransactionData,
    signatures: SafeSignature[]
): Hex {
    return encodeFunctionData({
        abi: safeAbi(context),
        functionName: "execTransaction",
        args: [
            transaction.to,
            BigInt(transaction.value),
            transaction.data,
            transaction.operation,
            BigInt(transaction.safeTxGas),
            BigInt(transaction.baseGas),
            BigInt(transaction.gasPrice),
            transaction.gasToken,
            transaction.refundReceiver,
            encodeSafeSignatures(signatures)
        ]
    })
}
