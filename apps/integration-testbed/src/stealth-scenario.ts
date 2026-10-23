import assert from "node:assert/strict"
import { p256 } from "@noble/curves/nist.js"
import { encodeFunctionData, getAddress, hexToBytes, http, parseAbi } from "viem"
import { createBundlerClient, toSimple7702SmartAccount } from "viem/account-abstraction"
import { privateKeyToAccount } from "viem/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import {
    fetchPaymasterSemaphoreGroup,
    generatePaymasterProof,
    Identity,
    signDelegationIfUndelegated
} from "@coordination-network/account"
import {
    buildAnnouncement,
    checkStealthAddress,
    deriveEddsaKeypair,
    derivePaymasterKeypair,
    deriveKeys,
    eddsaPeerPointBytes,
    encodeMetaStealthAddress,
    generateStealthPrivateKey
} from "@coordination-network/identity"
import { Chain } from "./anvil"
import type { TestbedBundler } from "./alto-bundler"
import { StealthDeployment } from "./deployer"
import type { TestbedIndexer } from "./indexer-harness"
import { personas, type UserSecrets } from "./personas"

const TOKEN_ID = 1n
const INITIAL_AMOUNT = 100n
const BOB_AMOUNT = 40n
const CHARLIE_AMOUNT = 25n

const tokenAbi = parseAbi([
    "function mint(address account, uint256 id, uint256 amount)",
    "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)"
])

const announcerAbi = parseAbi([
    "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"
])

type StealthKeys = ReturnType<typeof deriveKeys>
type Announcement = ReturnType<typeof buildAnnouncement>

type Recipient = {
    name: string
    keys: StealthKeys
    amount: bigint
    delivery: Announcement
}

export type StealthScenarioOptions = {
    includeCharlie: boolean
    alice?: UserSecrets
    authorizeDelivery?: () => Promise<boolean>
    credentialActiveDuringTransfer?: boolean
}

function metaStealthAddress(keys: StealthKeys) {
    return encodeMetaStealthAddress({
        spendingPublicKey: keys.spending.publicKey,
        viewingPublicKey: keys.viewing.publicKey
    })
}

function ownsAnnouncement(keys: StealthKeys, announcement: Announcement): boolean {
    return checkStealthAddress({
        stealthAddress: announcement.stealthAddress,
        ephemeralPublicKey: announcement.ephemeralPublicKey,
        spendingPublicKey: keys.spending.publicKey,
        viewingPrivateKey: keys.viewing.privateKey,
        viewTag: Number.parseInt(announcement.metadata.slice(2, 4), 16)
    })
}

function recipient(name: string, deviceSecret: Uint8Array, amount: bigint): Recipient {
    const keys = deriveKeys(deviceSecret)
    return {
        name,
        keys,
        amount,
        delivery: buildAnnouncement({ metaStealthAddress: metaStealthAddress(keys) })
    }
}

function summaryTable(rows: string[][]): string[] {
    const headers = ["User", "Tokens", "Stealth account", "Credential", "ETH"]
    const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)))
    const separator = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`
    const formatRow = (row: string[]) => `| ${row.map((value, column) => value.padEnd(widths[column])).join(" | ")} |`

    return [separator, formatRow(headers), separator, ...rows.map(formatRow), separator]
}

export async function runStealthScenario(
    chain: Chain,
    deployment: StealthDeployment,
    bundler: TestbedBundler,
    indexer: TestbedIndexer,
    options: StealthScenarioOptions,
    diagnostic: (message: string) => void = () => {}
): Promise<void> {
    const alice: UserSecrets = options.alice ?? personas.alice
    const aliceKeys = deriveKeys(alice.deviceSecret)
    const recipients = [
        recipient(personas.bob.name, personas.bob.deviceSecret, BOB_AMOUNT),
        ...(options.includeCharlie
            ? [recipient(personas.charlie.name, personas.charlie.deviceSecret, CHARLIE_AMOUNT)]
            : [])
    ]
    const registeredUsers = [{ name: personas.alice.name, keys: aliceKeys }, ...recipients]
    const registrationBlock = (await chain.publicClient.getBlockNumber({ cacheTime: 0 })) + 1n

    await indexer.registerKey({
        networkId: aliceKeys.networkId,
        spendingPublicKey: aliceKeys.spending.publicKey,
        viewingPrivateKey: aliceKeys.viewing.privateKey,
        fromBlock: registrationBlock
    })

    await Promise.all(
        recipients.map(({ keys }) =>
            indexer.registerKey({
                networkId: keys.networkId,
                spendingPublicKey: keys.spending.publicKey,
                viewingPrivateKey: keys.viewing.privateKey,
                fromBlock: registrationBlock
            })
        )
    )
    diagnostic(`Registered ${registeredUsers.map(({ name }) => name).join(", ")} with the indexer`)

    const aliceDelivery = buildAnnouncement({ metaStealthAddress: metaStealthAddress(aliceKeys) })

    assert.equal(ownsAnnouncement(aliceKeys, aliceDelivery), true)
    for (const { keys } of recipients) assert.equal(ownsAnnouncement(keys, aliceDelivery), false)

    if (options.authorizeDelivery) {
        assert.equal(await options.authorizeDelivery(), true, "Alice's credential is not active")
        diagnostic("Delivery policy accepted Alice's active credential")
    }
    const mintHash = await chain.walletClient.writeContract({
        address: deployment.token.address,
        abi: tokenAbi,
        functionName: "mint",
        args: [aliceDelivery.stealthAddress, TOKEN_ID, INITIAL_AMOUNT],
        account: chain.signer,
        chain: chain.chainDefinition
    })
    await chain.publicClient.waitForTransactionReceipt({ hash: mintHash })

    const memberAnnounceHash = await chain.walletClient.writeContract({
        address: deployment.announcer.address,
        abi: announcerAbi,
        functionName: "announce",
        args: [
            BigInt(aliceDelivery.schemeId),
            aliceDelivery.stealthAddress,
            aliceDelivery.ephemeralPublicKey,
            aliceDelivery.metadata
        ],
        account: chain.signer,
        chain: chain.chainDefinition
    })
    const memberAnnouncementReceipt = await chain.publicClient.waitForTransactionReceipt({ hash: memberAnnounceHash })
    diagnostic(`Member -> Alice: ${INITIAL_AMOUNT} tokens; mint ${mintHash}; announcement ${memberAnnounceHash}`)

    await indexer.waitUntilScanned(memberAnnouncementReceipt.blockNumber)
    const [aliceAccounts, ...recipientAccountsBeforeTransfer] = await Promise.all(
        registeredUsers.map(({ keys }) => indexer.accounts(keys.networkId))
    )
    assert.equal(aliceAccounts.length, 1)
    assert.equal(getAddress(aliceAccounts[0].stealthAddress), getAddress(aliceDelivery.stealthAddress))
    for (const accounts of recipientAccountsBeforeTransfer) assert.equal(accounts.length, 0)
    const discoveredByAlice = aliceAccounts[0]
    diagnostic(`Alice discovered stealth account ${aliceDelivery.stealthAddress} automatically; balance 100`)

    const aliceStealthPrivateKey = generateStealthPrivateKey({
        ephemeralPublicKey: discoveredByAlice.ephemeralPublicKey,
        viewingPrivateKey: aliceKeys.viewing.privateKey,
        spendingPrivateKey: aliceKeys.spending.privateKey
    })
    const aliceStealthAccount = privateKeyToAccount(aliceStealthPrivateKey)
    assert.equal(aliceStealthAccount.address.toLowerCase(), aliceDelivery.stealthAddress.toLowerCase())
    assert.equal(await chain.publicClient.getBalance({ address: aliceStealthAccount.address }), 0n)

    const ecdhSharedSecret = p256.getSharedSecret(alice.devicePrivateKey, eddsaPeerPointBytes()).slice(1, 33)
    const holderKeys = deriveEddsaKeypair(ecdhSharedSecret)
    const paymasterKeys = derivePaymasterKeypair(ecdhSharedSecret)
    assert.notEqual(
        paymasterKeys.commitment,
        holderKeys.commitment,
        "paymaster leaf must not identify the credential holder"
    )

    const groupId = (await chain.publicClient.readContract({
        address: deployment.execution.paymaster.address,
        abi: deployment.execution.paymaster.abi,
        functionName: "GROUP_ID"
    })) as bigint
    const isSponsored = (await chain.publicClient.readContract({
        address: deployment.execution.paymaster.address,
        abi: deployment.execution.paymaster.abi,
        functionName: "hasMember",
        args: [groupId, paymasterKeys.commitment]
    })) as boolean
    if (!isSponsored) {
        const addMemberHash = await chain.walletClient.writeContract({
            address: deployment.execution.paymaster.address,
            abi: deployment.execution.paymaster.abi,
            functionName: "addMember",
            args: [groupId, paymasterKeys.commitment],
            account: chain.signer,
            chain: chain.chainDefinition
        })
        await chain.publicClient.waitForTransactionReceipt({ hash: addMemberHash })
    }

    const paymasterIdentity = new Identity(hexToBytes(paymasterKeys.seed))
    const paymasterGroup = await fetchPaymasterSemaphoreGroup({
        rpcUrl: chain.rpcUrl,
        semaphoreContract: deployment.execution.paymaster.address,
        groupId,
        startBlock: deployment.paymasterGroupStartBlock,
        blockScanWindowSize: chain.blockScanWindowSize
    })
    const paymasterData = await generatePaymasterProof({
        identity: paymasterIdentity,
        group: paymasterGroup,
        sender: aliceStealthAccount.address
    })

    const paymasterDepositBefore = (await chain.publicClient.readContract({
        address: deployment.execution.paymaster.address,
        abi: deployment.execution.paymaster.abi,
        functionName: "getDeposit"
    })) as bigint
    const aliceSmartAccount = await toSimple7702SmartAccount({
        client: chain.publicClient,
        owner: aliceStealthAccount,
        implementation: deployment.execution.accountImplementation.address
    })
    const pimlicoClient = createPimlicoClient({ transport: http(bundler.rpcUrl) })
    const bundlerClient = createBundlerClient({
        client: chain.publicClient,
        transport: http(bundler.rpcUrl),
        userOperation: {
            estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).standard
        }
    })

    // Each recipient gets a separate transaction. The transfer and its announcement remain atomic,
    // but Bob and Charlie no longer appear as co-recipients in one UserOperation.
    const transactionHashes = new Set<string>()
    let lastSponsoredBlock: bigint | null = null
    for (const { name, amount, delivery } of recipients) {
        const transferData = encodeFunctionData({
            abi: tokenAbi,
            functionName: "safeTransferFrom",
            args: [aliceDelivery.stealthAddress, delivery.stealthAddress, TOKEN_ID, amount, "0x"]
        })
        const announcementData = encodeFunctionData({
            abi: announcerAbi,
            functionName: "announce",
            args: [BigInt(delivery.schemeId), delivery.stealthAddress, delivery.ephemeralPublicKey, delivery.metadata]
        })
        const calls = [
            { to: deployment.token.address, data: transferData },
            { to: deployment.announcer.address, data: announcementData }
        ]
        // The first operation installs the delegation; later operations use the installed code.
        const delegation = await signDelegationIfUndelegated({
            client: chain.publicClient,
            account: aliceStealthAccount,
            implementation: deployment.execution.accountImplementation.address
        })
        const estimate = await bundlerClient.estimateUserOperationGas({
            account: aliceSmartAccount,
            calls,
            paymaster: deployment.execution.paymaster.address,
            paymasterData,
            ...delegation
        })
        const estimatedPaymasterVerificationGas = estimate.paymasterVerificationGasLimit ?? 0n
        const paymasterVerificationGasLimit = estimatedPaymasterVerificationGas + estimatedPaymasterVerificationGas / 2n
        const userOperationHash = await bundlerClient.sendUserOperation({
            account: aliceSmartAccount,
            calls,
            paymaster: deployment.execution.paymaster.address,
            paymasterData,
            ...estimate,
            paymasterVerificationGasLimit,
            ...delegation
        })
        const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: userOperationHash })
        transactionHashes.add(receipt.transactionHash)
        lastSponsoredBlock = receipt.blockNumber
        diagnostic(
            `Alice sent ${amount} to ${name}; paymaster sponsored user operation ${userOperationHash}; transaction ${receipt.transactionHash}; Alice gas 0 ETH`
        )
    }
    assert.equal(transactionHashes.size, recipients.length, "each recipient must have a separate transaction")
    const paymasterDepositAfter = (await chain.publicClient.readContract({
        address: deployment.execution.paymaster.address,
        abi: deployment.execution.paymaster.abi,
        functionName: "getDeposit"
    })) as bigint
    assert.equal(await chain.publicClient.getBalance({ address: aliceStealthAccount.address }), 0n)
    assert.ok(paymasterDepositAfter < paymasterDepositBefore)
    assert.ok(lastSponsoredBlock !== null)
    await indexer.waitUntilScanned(lastSponsoredBlock)
    const indexedUsers = await Promise.all(
        registeredUsers.map(async ({ name, keys }) => ({
            name,
            accounts: await indexer.accounts(keys.networkId),
            balances: await indexer.balances(keys.networkId, [TOKEN_ID])
        }))
    )
    const transferredAmount = recipients.reduce((total, { amount }) => total + amount, 0n)
    const expectedBalances = [INITIAL_AMOUNT - transferredAmount, ...recipients.map(({ amount }) => amount)]

    indexedUsers.forEach(({ accounts, balances }, index) => {
        const expectedAddress =
            index === 0 ? aliceDelivery.stealthAddress : recipients[index - 1].delivery.stealthAddress
        assert.equal(accounts.length, 1)
        assert.equal(getAddress(accounts[0].stealthAddress), getAddress(expectedAddress))
        assert.equal(balances.length, 1)
        assert.equal(balances[0].balance, expectedBalances[index].toString())
    })

    recipients.forEach(({ name, delivery }) =>
        diagnostic(`${name} discovered stealth account ${delivery.stealthAddress} automatically`)
    )
    diagnostic(
        `Indexer balances for token ${TOKEN_ID}: ${indexedUsers
            .map(({ name, balances }) => `${name} ${balances[0].balance}`)
            .join("; ")}`
    )

    const credentialActiveDuringTransfer = options.credentialActiveDuringTransfer ?? false
    diagnostic(`Simulation summary (active credentials during transfer: ${credentialActiveDuringTransfer ? 1 : 0})`)
    const summaryRows = indexedUsers.map(({ name, balances }, index) => [
        name,
        balances[0].balance,
        index === 0 ? "Recovered" : "Discovered",
        index === 0 ? (credentialActiveDuringTransfer ? "Active" : "Revoked") : "—",
        index === 0 ? "0" : "—"
    ])
    for (const line of summaryTable(summaryRows)) diagnostic(line)
}
