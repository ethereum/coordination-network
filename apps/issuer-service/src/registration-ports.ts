import { createPublicClient, createWalletClient, defineChain, http, nonceManager } from "viem"
import type { Address, Chain, Hex, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
    IdentityRegistryClient,
    IdentityRegistryWriter,
    SemaphoreGroupClient,
    SemaphoreRegistrationProver,
    SponsoredIdentityRegistryWriter
} from "@coordination-network/network-member-client"
import type { SubmitRegistrationPorts } from "@coordination-network/network-member-client"
import { Identity } from "@semaphore-protocol/identity"
import { withLogWindow } from "./chain-logs"
import { Config, SponsoredConfig } from "./config"
import { connectSponsoredStack } from "./sponsored-stack"

/** The `IdentityRegistry` getters a member's own adapters need but network-member-client doesn't export an ABI for. */
const REGISTRY_LOCATION_ABI = [
    { type: "function", name: "SEMAPHORE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    {
        type: "function",
        name: "NETWORK_MEMBER_GROUP_ID",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    }
] as const

/**
 * `defineChain` plus a live client, checked once against the config's own `chainId` so a
 * misconfigured RPC_URL fails loudly here rather than downstream. Shared by both builders below.
 */
async function connectRegistrationChain(
    chainId: number,
    rpcUrl: string,
    name: string
): Promise<{ chain: Chain; publicClient: PublicClient }> {
    const chain = defineChain({
        id: chainId,
        name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
    })
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

    const observedChainId = await publicClient.getChainId()
    if (observedChainId !== chainId) {
        throw new Error(`RPC at ${rpcUrl} reports chain ${observedChainId}, but CHAIN_ID is ${chainId}`)
    }

    return { chain, publicClient }
}

/** The member's own approved-member group, mirrored from the `IdentityRegistry`'s Semaphore
 *  deployment and group id. Shared by both builders below. */
export async function mirrorMemberGroup(
    publicClient: PublicClient,
    identityRegistryAddress: Address,
    memberGroupFromBlock: number,
    logWindowBlocks?: number
): Promise<SemaphoreGroupClient> {
    const [semaphoreAddress, groupId] = await Promise.all([
        publicClient.readContract({
            address: identityRegistryAddress,
            abi: REGISTRY_LOCATION_ABI,
            functionName: "SEMAPHORE"
        }),
        publicClient.readContract({
            address: identityRegistryAddress,
            abi: REGISTRY_LOCATION_ABI,
            functionName: "NETWORK_MEMBER_GROUP_ID"
        })
    ])
    return new SemaphoreGroupClient(semaphoreAddress, groupId, withLogWindow(publicClient, logWindowBlocks), {
        fromBlock: BigInt(memberGroupFromBlock)
    })
}

export type DirectRegistrationConfig = NonNullable<Config["registration"]> & {
    submitterPrivateKey: Hex
}

export async function buildRegistrationPorts(
    registration: DirectRegistrationConfig,
    rpcUrl: string
): Promise<SubmitRegistrationPorts> {
    const {
        identityRegistryAddress,
        chainId,
        memberIdentitySecret,
        submitterPrivateKey,
        memberGroupFromBlock,
        logWindowBlocks
    } = registration
    const { chain, publicClient } = await connectRegistrationChain(chainId, rpcUrl, "issuer-service-registration-chain")
    const walletClient = createWalletClient({
        // A nonce manager tracks the pending nonce itself, so concurrent registrations don't
        // collide submitting against the same account's next nonce.
        account: privateKeyToAccount(submitterPrivateKey, { nonceManager }),
        chain,
        transport: http(rpcUrl)
    })

    const registry = { chainId: BigInt(chainId), address: identityRegistryAddress }
    const groupMirror = await mirrorMemberGroup(
        publicClient,
        identityRegistryAddress,
        memberGroupFromBlock,
        logWindowBlocks
    )
    const prover = new SemaphoreRegistrationProver({
        identity: new Identity(memberIdentitySecret),
        groupMirror,
        registry
    })

    return {
        domain: { chainId, verifyingContract: identityRegistryAddress },
        identityReader: new IdentityRegistryClient(identityRegistryAddress, publicClient),
        prover,
        writer: new IdentityRegistryWriter(registry, walletClient)
    }
}

/** Read-only IdentityRegistry adapter used by the credential-issuance enrolment gate. */
export async function buildIdentityReader(identityRegistryAddress: Address, chainId: number, rpcUrl: string) {
    const { publicClient } = await connectRegistrationChain(chainId, rpcUrl, "issuer-service-issuance-chain")
    return new IdentityRegistryClient(identityRegistryAddress, publicClient)
}

export type SponsoredRegistrationConfig = NonNullable<Config["registration"]> & {
    sponsored: SponsoredConfig
}

export async function buildSponsoredRegistrationPorts(
    config: SponsoredRegistrationConfig,
    rpcUrl: string
): Promise<SubmitRegistrationPorts> {
    const { identityRegistryAddress, chainId, memberIdentitySecret, memberGroupFromBlock, logWindowBlocks, sponsored } =
        config
    const { publicClient } = await connectRegistrationChain(
        chainId,
        rpcUrl,
        "issuer-service-sponsored-registration-chain"
    )

    const registry = { chainId: BigInt(chainId), address: identityRegistryAddress }
    const identity = new Identity(memberIdentitySecret)
    const [groupMirror, relayParams] = await Promise.all([
        mirrorMemberGroup(publicClient, identityRegistryAddress, memberGroupFromBlock, logWindowBlocks),
        connectSponsoredStack({ sponsored, chainId, identity, publicClient })
    ])
    const prover = new SemaphoreRegistrationProver({ identity, groupMirror, registry })

    return {
        domain: { chainId, verifyingContract: identityRegistryAddress },
        identityReader: new IdentityRegistryClient(identityRegistryAddress, publicClient),
        prover,
        writer: new SponsoredIdentityRegistryWriter({ registry, ...relayParams })
    }
}
