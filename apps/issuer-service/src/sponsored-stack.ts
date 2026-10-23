import { http } from "viem"
import type { Address, PublicClient } from "viem"
import { createBundlerClient } from "viem/account-abstraction"
import { deriveKeys, encodeMetaStealthAddress } from "@coordination-network/identity"
import { BundlerRpcSubmitter, SemaphoreGroupClient } from "@coordination-network/network-member-client"
import type { SponsoredRelayParams } from "@coordination-network/network-member-client"
import type { Identity } from "@semaphore-protocol/identity"
import { withLogWindow } from "./chain-logs"
import { SponsoredConfig } from "./config"

/** `SemaphorePaymaster` is itself a Semaphore group; this is the one getter its group mirror needs. */
const PAYMASTER_LOCATION_ABI = [
    { type: "function", name: "GROUP_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const

/**
 * Fails startup on a mistyped stack address or a bundler for another EntryPoint or chain, instead
 * of at the first sponsored call. EntryPoint v0.8 has one address everywhere, so the chain id is
 * what tells a bundler on another chain apart.
 */
async function assertStackIsLive(
    publicClient: PublicClient,
    entryPoint: Address,
    accountImplementation: Address,
    bundlerUrl: string,
    chainId: number
): Promise<void> {
    const bundler = createBundlerClient({ transport: http(bundlerUrl) })
    // The URL can carry an API key, so a transport error is reported without it.
    const unanswered = (method: string) => () => {
        throw new Error(`BUNDLER_URL did not answer ${method}`)
    }
    const [entryPointCode, accountImplementationCode, supportedEntryPoints, bundlerChainId] = await Promise.all([
        publicClient.getCode({ address: entryPoint }),
        publicClient.getCode({ address: accountImplementation }),
        bundler.request({ method: "eth_supportedEntryPoints" }).catch(unanswered("eth_supportedEntryPoints")),
        bundler.request({ method: "eth_chainId" }).catch(unanswered("eth_chainId"))
    ])
    if (entryPointCode === undefined) throw new Error(`no contract at ENTRY_POINT_ADDRESS ${entryPoint}`)
    if (accountImplementationCode === undefined) {
        throw new Error(`no contract at ACCOUNT_IMPLEMENTATION_ADDRESS ${accountImplementation}`)
    }
    if (!supportedEntryPoints.some((supported) => supported.toLowerCase() === entryPoint.toLowerCase())) {
        throw new Error(`bundler does not serve EntryPoint ${entryPoint}`)
    }
    if (Number(bundlerChainId) !== chainId) {
        throw new Error(`the bundler serves chain ${Number(bundlerChainId)}, not this deployment's chain ${chainId}`)
    }
}

/**
 * What a `SponsoredRelay` needs from a `SponsoredConfig`: the paymaster's group
 * mirror, the bundler and the member's stealth keys, after the live stack check.
 */
export async function connectSponsoredStack(params: {
    sponsored: SponsoredConfig
    chainId: number
    identity: Identity
    publicClient: PublicClient
}): Promise<SponsoredRelayParams> {
    const { sponsored, chainId, identity, publicClient } = params
    const {
        memberSecret,
        entryPoint,
        paymaster,
        accountImplementation,
        bundlerUrl,
        paymasterGroupFromBlock,
        logWindowBlocks
    } = sponsored

    const paymasterGroupId = await publicClient.readContract({
        address: paymaster,
        abi: PAYMASTER_LOCATION_ABI,
        functionName: "GROUP_ID"
    })
    await assertStackIsLive(publicClient, entryPoint, accountImplementation, bundlerUrl, chainId)

    const keys = deriveKeys(memberSecret)
    return {
        chainId,
        entryPoint,
        paymaster,
        accountImplementation,
        memberKeys: {
            metaStealthAddress: encodeMetaStealthAddress({
                spendingPublicKey: keys.spending.publicKey,
                viewingPublicKey: keys.viewing.publicKey
            }),
            spendingPrivateKey: keys.spending.privateKey,
            viewingPrivateKey: keys.viewing.privateKey
        },
        paymasterIdentity: identity,
        paymasterGroup: new SemaphoreGroupClient(
            paymaster,
            paymasterGroupId,
            withLogWindow(publicClient, logWindowBlocks),
            {
                fromBlock: BigInt(paymasterGroupFromBlock)
            }
        ),
        submitter: new BundlerRpcSubmitter(bundlerUrl, entryPoint),
        publicClient
    }
}
