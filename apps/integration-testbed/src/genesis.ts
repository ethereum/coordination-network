import {
    encodeFunctionData,
    formatEther,
    getAddress,
    isAddressEqual,
    nonceManager,
    parseAbi,
    type Account,
    type Address,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
    buildAdmissionTransaction,
    checkQuorum,
    encodeApproveHash,
    encodeExecTransaction,
    governanceThreshold,
    hashSafeTransaction,
    onChainApproval,
    type SafeContext,
    type SafeTransactionData
} from "@coordination-network/network-member-governance"
import { OperatorError } from "./operator-error"
import { createReconciler, reconcilePaymasterGroup } from "./paymaster-group"
import { lanAddress } from "./members"
import {
    accountKeyOf,
    BUNDLER_ACCOUNT,
    issuerKeyCapMessage,
    issuerLeafOf,
    MAX_ISSUER_KEYS_PER_MEMBER,
    ORG_ACCOUNT,
    PAYMASTER_DEPOSIT_TARGET,
    readIsApproved,
    readIssuerKeys,
    readPaymasterDeposit,
    readSafeState,
    SAFE_ABI,
    type TestnetStack
} from "./testnet-stack"

const ADMISSION_SETTLE_TIMEOUT_MS = 60_000
const ADMISSION_SETTLE_INTERVAL_MS = 250

const ENTRY_POINT_ABI = parseAbi(["function depositTo(address account) payable"])
const ISSUER_SET_WRITE_ABI = parseAbi([
    "function publishIssuerKey(bytes32 memberNetworkId, uint256 publicKeyX, uint256 publicKeyY) returns (uint256)"
])

/**
 * The one-time setup a network deployed with `deployAndConfigureAll` needs before the stack can serve
 * it: funded accounts, Member A and Member B admitted beside the founding member, their issuer keys published
 * and the paymaster group mirrored. Every step first reads whether it is already true, so a second
 * run, or a run against a half-set-up network, changes only what is missing.
 *
 * `heldKeys` are the keys the operator holds that may sign: OWNER, the founders' governance keys and
 * the founders' auth keys. Resolves to what it did.
 */
export async function runGenesis(
    stack: TestnetStack,
    heldKeys: Hex[],
    diagnostic: (message: string) => void
): Promise<string[]> {
    const { chain, addresses, members } = stack
    const { publicClient } = chain
    const founders = members.filter((member) => member.role === "founder")
    const actions: string[] = []

    const held = new Map<string, Account>()
    for (const key of heldKeys) {
        const account = privateKeyToAccount(key, { nonceManager })
        held.set(account.address.toLowerCase(), account)
    }
    // The chain's own signer replaces OWNER's key above, so its nonce manager orders every send.
    if (typeof chain.signer !== "string") held.set(chain.signer.address.toLowerCase(), chain.signer)
    const owner = held.get(chain.deployer.toLowerCase())
    if (!owner) throw new OperatorError("OWNER's key is not among the keys genesis holds")

    const send = async (label: string, account: Account, transaction: { to: Address; data?: Hex; value?: bigint }) => {
        const hash = await chain.walletClient.sendTransaction({ account, chain: chain.chainDefinition, ...transaction })
        // Before the wait: a failed wait still leaves the hash, so a rerun can tell pending from missing.
        diagnostic(`${label}: sent ${hash}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status === "reverted") throw new Error(`${label} reverted: ${hash}`)
        diagnostic(`${label}: confirmed`)
        actions.push(label)
    }

    const topUp = async (label: string, address: Address, { floor, target }: { floor: bigint; target: bigint }) => {
        const balance = await publicClient.getBalance({ address })
        if (balance >= floor) return
        await send(`fund ${label} to ${formatEther(target)} ETH`, owner, { to: address, value: target - balance })
    }

    const context: SafeContext = {
        safeAddress: addresses.governanceSafe,
        chainId: stack.chainId,
        safeVersion: stack.safeVersion,
        multiSend: stack.multiSend
    }
    const safeState = async () => {
        const { owners, threshold } = await readSafeState(publicClient, context.safeAddress)
        return { owners: [...owners], threshold: Number(threshold) }
    }
    const isApproved = (networkId: Hex) => readIsApproved(publicClient, addresses.networkMemberRegistry, networkId)
    const safeView = async () => {
        const [state, nonce] = await Promise.all([
            safeState(),
            publicClient.readContract({ address: context.safeAddress, abi: SAFE_ABI, functionName: "nonce" })
        ])
        return { ...state, nonce }
    }
    type SafeView = Awaited<ReturnType<typeof safeView>>

    /** The admission as the Safe sees it in `view`: its nonce and owner count. */
    const admissionTransaction = (member: (typeof founders)[number], view: SafeView) => {
        const { accountKeyX, accountKeyY, memberNetworkId } = accountKeyOf(member)
        if (memberNetworkId !== member.networkId) {
            throw new Error(`${member.name}'s networkId is not the id of its account key`)
        }
        return buildAdmissionTransaction(
            { governance: addresses.networkMemberGovernance, registry: addresses.networkMemberRegistry },
            {
                memberNetworkId: member.networkId,
                accountKeyX,
                accountKeyY,
                semaphoreCommitment: member.semaphoreCommitment,
                governanceSigner: member.governanceSignerAddress,
                metadataURI: `http://${lanAddress()}:${member.port}`
            },
            context,
            Number(view.nonce),
            view.owners.length
        )
    }

    /** Turns a Safe-version or encoding mismatch into a clear failure, rather than the Safe's opaque
     *  GS026 at execution. */
    const safeHashOf = async (transaction: SafeTransactionData): Promise<Hex> => {
        const safeTxHash = hashSafeTransaction(context, transaction)
        const onChainHash = await publicClient.readContract({
            address: context.safeAddress,
            abi: SAFE_ABI,
            functionName: "getTransactionHash",
            args: [
                getAddress(transaction.to),
                BigInt(transaction.value),
                transaction.data as Hex,
                transaction.operation,
                BigInt(transaction.safeTxGas),
                BigInt(transaction.baseGas),
                BigInt(transaction.gasPrice),
                getAddress(transaction.gasToken),
                getAddress(transaction.refundReceiver),
                BigInt(transaction.nonce)
            ]
        })
        if (onChainHash !== safeTxHash) {
            throw new Error(`safeTxHash ${safeTxHash} does not match the Safe's own ${onChainHash}`)
        }
        return safeTxHash
    }

    // Everything below is refused before anything is spent, so a run that cannot finish sends nothing.
    const pending = []
    for (const member of founders) {
        if (!(await isApproved(member.networkId))) pending.push(member)
    }
    const initial = await safeState()
    if (pending.length > 0) {
        const rule = governanceThreshold(initial.owners.length)
        if (initial.threshold !== rule) {
            throw new OperatorError(
                `genesis: the Safe's threshold is ${initial.threshold} for ${initial.owners.length} owner(s), the governance rule gives ${rule}; the owners restore it with the Safe's changeThreshold`
            )
        }
        // Each admission is signed by the owners at that moment; the next one also has the founder just admitted.
        const seats = initial.owners.map((address) => address.toLowerCase())
        for (const member of pending) {
            const signer = member.governanceSignerAddress
            if (seats.includes(signer.toLowerCase())) {
                throw new OperatorError(
                    `genesis: ${member.name}'s governance signer ${signer} already owns a Safe seat but ${member.name} is not approved`
                )
            }
            const reached = seats.filter((seat) => held.has(seat)).length
            const needed = governanceThreshold(seats.length)
            if (reached < needed) {
                throw new OperatorError(
                    `admit ${member.name}: the Safe needs ${needed} approvals and the held keys reach ${reached}`
                )
            }
            seats.push(signer.toLowerCase())
        }
        await safeHashOf(admissionTransaction(pending[0], await safeView()))
    }

    const unkeyed: { member: (typeof founders)[number]; account: Account }[] = []
    for (const member of founders) {
        const keys = await readIssuerKeys(publicClient, addresses.approvedIssuerSet, member.networkId)
        if (keys.includes(await issuerLeafOf(member))) continue
        if (keys.length >= MAX_ISSUER_KEYS_PER_MEMBER) throw new OperatorError(issuerKeyCapMessage(member, keys.length))
        const account = held.get(member.authAddress.toLowerCase())
        if (!account) throw new OperatorError(`${member.name}'s auth key is not among the keys genesis holds`)
        unkeyed.push({ member, account })
    }

    // Accounts first: everything after spends from one of them.
    for (const member of members) await topUp(`${member.name} auth account`, member.authAddress, ORG_ACCOUNT)
    for (const member of founders) {
        await topUp(`${member.name} governance signer`, member.governanceSignerAddress, ORG_ACCOUNT)
    }
    await topUp("the bundler", stack.bundlerAccount.address, BUNDLER_ACCOUNT)

    const deposit = await readPaymasterDeposit(publicClient, addresses.paymaster)
    if (deposit < PAYMASTER_DEPOSIT_TARGET) {
        // Never stake: only the deposit the paymaster pays user operations from.
        await send(`deposit ${formatEther(PAYMASTER_DEPOSIT_TARGET - deposit)} ETH for the paymaster`, owner, {
            to: addresses.entryPoint,
            data: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "depositTo", args: [addresses.paymaster] }),
            value: PAYMASTER_DEPOSIT_TARGET - deposit
        })
    }

    /** Waits until the provider serves the Safe as the admission left it, and returns what it served, so
     *  the next admission is built from that and not from a second read that may hit a lagging backend. */
    const admissionVisible = async (member: (typeof founders)[number], nonce: number): Promise<SafeView> => {
        const deadline = Date.now() + ADMISSION_SETTLE_TIMEOUT_MS
        for (;;) {
            const view = await safeView()
            if (
                view.owners.some((seat) => isAddressEqual(seat, member.governanceSignerAddress)) &&
                view.nonce > BigInt(nonce)
            ) {
                return view
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `${member.name}'s admission is not visible at the Safe after ${ADMISSION_SETTLE_TIMEOUT_MS}ms`
                )
            }
            await new Promise((resolve) => setTimeout(resolve, ADMISSION_SETTLE_INTERVAL_MS))
        }
    }

    /** Has held owners approve `transaction` until the Safe's threshold is met, then executes it. */
    const executeThroughSafe = async (
        label: string,
        transaction: SafeTransactionData,
        { owners, threshold }: SafeView
    ) => {
        const safeTxHash = await safeHashOf(transaction)

        const approvedBy: Address[] = []
        for (const safeOwner of owners) {
            const approved = await publicClient.readContract({
                address: context.safeAddress,
                abi: SAFE_ABI,
                functionName: "approvedHashes",
                args: [safeOwner, safeTxHash]
            })
            if (approved !== 0n) approvedBy.push(safeOwner)
        }
        const heldOwners = owners.flatMap((safeOwner) => held.get(safeOwner.toLowerCase()) ?? [])

        const reachable = checkQuorum(owners, threshold, [
            ...approvedBy,
            ...heldOwners.map((account) => account.address)
        ])
        if (!reachable.hasQuorum) {
            throw new OperatorError(
                `${label}: the Safe needs ${threshold} approvals and the held keys reach ${reachable.signers.length}`
            )
        }
        for (const account of heldOwners) {
            if (checkQuorum(owners, threshold, approvedBy).hasQuorum) break
            if (approvedBy.some((approver) => isAddressEqual(approver, account.address))) continue

            await send(`${label}: approve as ${account.address}`, account, {
                to: context.safeAddress,
                data: encodeApproveHash(context, safeTxHash)
            })
            approvedBy.push(account.address)
        }

        const quorum = checkQuorum(owners, threshold, approvedBy)
        await send(label, owner, {
            to: context.safeAddress,
            data: encodeExecTransaction(context, transaction, quorum.signers.map(onChainApproval))
        })
    }

    let view = await safeView()
    for (const member of pending) {
        // Another run may have admitted it since the refusal checks.
        if (await isApproved(member.networkId)) {
            view = await safeView()
            continue
        }

        const transaction = admissionTransaction(member, view)
        await executeThroughSafe(`admit ${member.name}`, transaction, view)
        view = await admissionVisible(member, transaction.nonce)
    }

    for (const { member, account } of unkeyed) {
        const [publicKeyX, publicKeyY] = await member.signer.getPublicKey()
        await send(`publish ${member.name}'s issuer key`, account, {
            to: addresses.approvedIssuerSet,
            data: encodeFunctionData({
                abi: ISSUER_SET_WRITE_ABI,
                functionName: "publishIssuerKey",
                args: [member.networkId, publicKeyX, publicKeyY]
            })
        })
    }

    // No confirmation lag: the admissions above landed a block ago and must be mirrored in this run.
    const { paymaster, group, paymasterGroupFromBlock } = stack.paymasterMirror
    const mirrorOptions = {
        fromBlock: stack.deployBlock,
        paymasterGroupFromBlock,
        logWindowBlocks: stack.logWindowBlocks
    }
    const record = (commitment: bigint, change: "added" | "removed") =>
        actions.push(`${change === "added" ? "mirror" : "remove"} commitment ${commitment} in the paymaster group`)
    // The founders directly, not through the logs: a provider that lags behind their admissions would not serve those yet.
    const reconcile = createReconciler(chain, paymaster, group, mirrorOptions, diagnostic)
    for (const member of founders) {
        const change = await reconcile(member.semaphoreCommitment)
        if (change !== undefined) record(member.semaphoreCommitment, change)
    }
    const direct = new Set(founders.map((member) => member.semaphoreCommitment))
    const mirrored = await reconcilePaymasterGroup(chain, paymaster, group, mirrorOptions, diagnostic, direct)
    for (const { commitment, change } of mirrored) record(commitment, change)

    return actions
}
