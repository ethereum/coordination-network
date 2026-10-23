import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { after, before, describe, test } from "node:test"
import {
    Account,
    Chain,
    PublicClient,
    Transport,
    WalletClient,
    createPublicClient,
    createWalletClient,
    http
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { LocalCredentialSigner } from "@coordination-network/credential"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import { buildChainIssuerSet } from "../src/issuer-set"
import { DeployedIssuerSet, deployApprovedIssuerSet, startAnvil } from "./chain"

const PORT = 18979
const MEMBER_ACCOUNT = privateKeyToAccount(`0x${"15".repeat(32)}`)
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const

describe(`buildChainIssuerSet (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let rpcUrl: string
    let deployment: DeployedIssuerSet

    before(async () => {
        anvil = await startAnvil(PORT)
        rpcUrl = `http://127.0.0.1:${PORT}`
        publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ANVIL_KEY),
            chain: foundry,
            transport: http(rpcUrl),
            pollingInterval: 50
        })
        deployment = await deployApprovedIssuerSet(wallet, publicClient, wallet.account.address)
    })

    after(async () => {
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
    })

    test("reads no leaves and a zero root, and no root validates, before anything is published", async () => {
        const issuerSet = buildChainIssuerSet(deployment.issuerSet, rpcUrl)

        const state = await issuerSet.read()

        assert.deepEqual(state.leaves, [])
        assert.equal(state.root, 0n)
        // The contract's own rule: a zero root never validates, even though it's what an empty
        // set reads as, since zero is indistinguishable from "no root asserted".
        assert.equal(await issuerSet.isValidRoot(0n), false)
        assert.equal(await issuerSet.isValidRoot(1n), false)
    })

    test("reads a published key's leaf and root, matching the contract directly, and validates that root", async () => {
        const { memberNetworkId, accountKeyX, accountKeyY } = memberAccountKey(MEMBER_ACCOUNT.publicKey)
        const signer = new LocalCredentialSigner("issuer-set-e2e")
        const [x, y] = await signer.getPublicKey()

        // publishIssuerKey refuses an unapproved member even from governance, so the member must
        // hold a record on the registry first.
        const approveHash = await wallet.writeContract({
            address: deployment.registry,
            abi: deployment.registryAbi,
            functionName: "approveNetworkMember",
            args: [accountKeyX, accountKeyY, 1n, wallet.account.address],
            chain: foundry,
            account: wallet.account
        })
        await publicClient.waitForTransactionReceipt({ hash: approveHash })

        const publishHash = await wallet.writeContract({
            address: deployment.issuerSet,
            abi: deployment.issuerSetAbi,
            functionName: "publishIssuerKey",
            args: [memberNetworkId, x, y],
            chain: foundry,
            account: wallet.account
        })
        await publicClient.waitForTransactionReceipt({ hash: publishHash })

        const expectedRoot = await publicClient.readContract({
            address: deployment.issuerSet,
            abi: deployment.issuerSetAbi,
            functionName: "issuerSetRoot"
        })

        const issuerSet = buildChainIssuerSet(deployment.issuerSet, rpcUrl)
        const state = await issuerSet.read()

        assert.equal(state.leaves.length, 1)
        assert.equal(state.root, expectedRoot)
        assert.ok(state.blockNumber > 0n)
        assert.equal(await issuerSet.isValidRoot(state.root), true)
        assert.equal(await issuerSet.isValidRoot(state.root + 1n), false)
    })
})
