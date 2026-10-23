import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { after, before, describe, test } from "node:test"
import { getCurveFromName, type Curve } from "ffjavascript"
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
import { Hex32, InMemoryResolver } from "@coordination-network/credential"
import { RevocationAction, generateRevocationProof } from "@coordination-network/network-member-proof"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { buildChainRevocation } from "../src/revocation"
import {
    DeployedCredentialRevocationRegistry,
    addMember,
    deployCredentialRevocationRegistry,
    startAnvil
} from "./chain"

const PORT = 18975
const ISSUER_ID = `0x${"99".repeat(32)}` as Hex32
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_IDENTITY_SECRET = new Uint8Array(32).fill(0x99)

describe(`chain-backed revocation mirror rebuild (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let rpcUrl: string
    let deployment: DeployedCredentialRevocationRegistry
    let revocationConfig: {
        address: `0x${string}`
        memberIdentitySecret: Uint8Array
        memberPrivateKey: `0x${string}`
        memberGroupFromBlock: number
    }

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
        deployment = await deployCredentialRevocationRegistry(wallet, publicClient, wallet.account.address)
        // Nothing in the registry reads msg.sender; what authorises a write is membership in this
        // group, so the backing's own identity has to be admitted before it can revoke anything.
        await addMember(
            wallet,
            publicClient,
            deployment.semaphore,
            deployment.semaphoreAbi,
            deployment.groupId,
            new Identity(MEMBER_IDENTITY_SECRET).commitment
        )
        revocationConfig = {
            address: deployment.registry,
            memberIdentitySecret: MEMBER_IDENTITY_SECRET,
            memberPrivateKey: ANVIL_KEY,
            memberGroupFromBlock: 0
        }
    })

    after(async () => {
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
    })

    test("a second backing rebuilds the same mirror from chain history and can revoke through it", async () => {
        const baseResolver = new InMemoryResolver()
        baseResolver.approveMember(ISSUER_ID)

        const first = await buildChainRevocation(revocationConfig, rpcUrl, baseResolver)
        await first.revoke(111n)
        await first.revoke(222n)
        assert.equal(await first.isRevoked(111n), true)
        assert.equal(await first.isRevoked(222n), true)
        assert.notEqual(first.mirror.root, 0n)

        const second = await buildChainRevocation(revocationConfig, rpcUrl, baseResolver)
        assert.equal(second.mirror.root, first.mirror.root)
        assert.equal(second.mirror.isRevoked(111n), true)
        assert.equal(second.mirror.isRevoked(222n), true)

        await second.revoke(333n)
        assert.equal(await second.isRevoked(333n), true)
        assert.equal(await first.isRevoked(333n), true)
    })

    test("a fresh backing rebuilds correctly from leaves after an unrevoke tombstones a slot", async () => {
        const baseResolver = new InMemoryResolver()
        baseResolver.approveMember(ISSUER_ID)

        const first = await buildChainRevocation(revocationConfig, rpcUrl, baseResolver)
        await first.revoke(444n)
        await first.revoke(555n)

        // Not an event replay: an event-only rebuild would still see 444n as revoked, since
        // CredentialUnrevoked isn't a CredentialRevoked/CredentialsRevoked event.
        const identity = new Identity(MEMBER_IDENTITY_SECRET)
        const predecessorIndex = first.mirror.predecessorIndexOf(444n)
        const unrevokeProof = await generateRevocationProof({
            identity,
            group: new Group([identity.commitment]),
            registry: { chainId: BigInt(foundry.id), address: deployment.registry },
            update: { action: RevocationAction.Unrevoke, revocationCommitment: 444n }
        })
        const unrevokeHash = await wallet.writeContract({
            address: deployment.registry,
            abi: deployment.registryAbi,
            functionName: "unrevoke",
            args: [444n, BigInt(predecessorIndex), unrevokeProof],
            account: wallet.account,
            chain: foundry
        })
        await publicClient.waitForTransactionReceipt({ hash: unrevokeHash })

        const chainRoot = await publicClient.readContract({
            address: deployment.revocation,
            abi: deployment.revocationAbi,
            functionName: "getRevocationRoot",
            args: [deployment.registryId]
        })

        const fresh = await buildChainRevocation(revocationConfig, rpcUrl, baseResolver)
        assert.equal(fresh.mirror.root, chainRoot)
        assert.equal(await fresh.isRevoked(444n), false)
        assert.equal(fresh.mirror.isRevoked(444n), false)
        assert.equal(fresh.mirror.isRevoked(555n), true)
    })

    test("a newly admitted member can revoke a commitment without an issuer key or issuer signature", async () => {
        const memberSecret = new Uint8Array(32).fill(0x77)
        await addMember(
            wallet,
            publicClient,
            deployment.semaphore,
            deployment.semaphoreAbi,
            deployment.groupId,
            new Identity(memberSecret).commitment
        )

        const baseResolver = new InMemoryResolver()
        const original = await buildChainRevocation(revocationConfig, rpcUrl, baseResolver)
        const newcomer = await buildChainRevocation(
            { ...revocationConfig, memberIdentitySecret: memberSecret },
            rpcUrl,
            baseResolver
        )
        await newcomer.revoke(777n)
        assert.equal(await original.isRevoked(777n), true)
        assert.equal(await newcomer.isRevoked(777n), true)
    })
})

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

before(async () => {
    curve = await getCurveFromName("bn128")
})

after(async () => {
    await curve.terminate()
})
