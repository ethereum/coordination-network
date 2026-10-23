import { createPublicClient, createWalletClient, defineChain, http, nonceManager } from "viem"
import type { Chain, Hex, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ApprovalResolver } from "@coordination-network/credential"
import {
    ERC5564AnnouncerClient,
    IdentityRegistryClient,
    SponsoredAnnouncementSubmitter,
    SponsoredRelay
} from "@coordination-network/network-member-client"
import type { DeliverToStealthPorts } from "@coordination-network/network-member-client"
import { Identity } from "@semaphore-protocol/identity"
import { Config, SponsoredConfig } from "./config"
import { connectSponsoredStack } from "./sponsored-stack"

export type DirectDeliveryConfig = NonNullable<Config["delivery"]> & { memberPrivateKey: Hex }

export type SponsoredDeliveryConfig = NonNullable<Config["delivery"]> & {
    sponsored: SponsoredConfig
    memberIdentitySecret: Uint8Array
}

async function connectDeliveryChain(
    chainId: number,
    rpcUrl: string
): Promise<{ chain: Chain; publicClient: PublicClient }> {
    const chain = defineChain({
        id: chainId,
        name: "issuer-service-delivery-chain",
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

export async function buildDeliveryPorts(
    delivery: DirectDeliveryConfig,
    rpcUrl: string,
    approval: ApprovalResolver
): Promise<DeliverToStealthPorts> {
    const { identityRegistryAddress, chainId, announcerAddress, memberPrivateKey } = delivery
    const { chain, publicClient } = await connectDeliveryChain(chainId, rpcUrl)
    const walletClient = createWalletClient({
        account: privateKeyToAccount(memberPrivateKey, { nonceManager }),
        chain,
        transport: http(rpcUrl)
    })

    return {
        approval,
        identityReader: new IdentityRegistryClient(identityRegistryAddress, publicClient),
        submitter: new ERC5564AnnouncerClient(announcerAddress, walletClient)
    }
}

/** Sponsored counterpart of {@link buildDeliveryPorts}. */
export async function buildSponsoredDeliveryPorts(
    delivery: SponsoredDeliveryConfig,
    rpcUrl: string,
    approval: ApprovalResolver
): Promise<DeliverToStealthPorts> {
    const { identityRegistryAddress, chainId, announcerAddress, memberIdentitySecret, sponsored } = delivery
    const { publicClient } = await connectDeliveryChain(chainId, rpcUrl)
    const relayParams = await connectSponsoredStack({
        sponsored,
        chainId,
        identity: new Identity(memberIdentitySecret),
        publicClient
    })

    return {
        approval,
        identityReader: new IdentityRegistryClient(identityRegistryAddress, publicClient),
        submitter: new SponsoredAnnouncementSubmitter(announcerAddress, new SponsoredRelay(relayParams))
    }
}
