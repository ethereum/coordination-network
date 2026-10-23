import { createPublicClient, http } from "viem"
import type { Address, PublicClient } from "viem"
import type { Hex } from "@coordination-network/identity"
import type { ChainRoots, MemberDirectory, RootAuthority } from "@coordination-network/user-app-core"
import type { StackDescriptor } from "./config"

const clients = new Map<string, PublicClient>()

/** One client per RPC URL for the app's lifetime, instead of a new one on every read. */
function clientFor(rpcUrl: string): PublicClient {
    let client = clients.get(rpcUrl)
    if (client === undefined) {
        client = createPublicClient({ transport: http(rpcUrl) })
        clients.set(rpcUrl, client)
    }
    return client
}

// Identity Registry exposes its mapping through Solidity's auto-generated getter:
// `mapping(bytes32 networkId => bytes metaStealthAddress) public identity`.
const identityRegistryAbi = [
    {
        type: "function",
        name: "identity",
        stateMutability: "view",
        inputs: [{ name: "networkId", type: "bytes32" }],
        outputs: [{ name: "", type: "bytes" }]
    }
] as const

// The revocation service holding the network's one credential tree. `registryId` names that tree
// inside it, and both come from `stack.json` - see `revocation` in `config.ts`.
const revocationAbi = [
    {
        type: "function",
        name: "isRevoked",
        stateMutability: "view",
        inputs: [
            { name: "registryId", type: "uint256" },
            { name: "revocationCommitment", type: "uint256" }
        ],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "getRevocationRoot",
        stateMutability: "view",
        inputs: [{ name: "registryId", type: "uint256" }],
        outputs: [{ type: "uint256" }]
    }
] as const

// Leaves of the member's live issuer keys; retirement and member removal clear the list.
const approvedIssuerSetAbi = [
    {
        type: "function",
        name: "issuerKeysOf",
        stateMutability: "view",
        inputs: [{ name: "networkId", type: "bytes32" }],
        outputs: [{ name: "", type: "uint256[]" }]
    },
    {
        type: "function",
        name: "issuerSetRoot",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "getLeafCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    }
] as const

/**
 * Whether the network has revoked this credential. One registry for every member is what makes
 * this answerable at all, and answerable without naming an issuer: there is no per-issuer tree to
 * choose, so the question says nothing about who signed the credential. The node serving the RPC
 * does see which commitment is asked about - the same exposure `readIsRegistered` already has, and
 * the reason a wallet that needed to hide even that would read the whole tree and test membership
 * itself.
 */
export async function readIsRevoked(
    rpcUrl: string,
    revocationService: Hex,
    registryId: bigint,
    commitment: bigint
): Promise<boolean> {
    return clientFor(rpcUrl).readContract({
        address: revocationService as Address,
        abi: revocationAbi,
        functionName: "isRevoked",
        args: [registryId, commitment]
    })
}

/** True once `identity(networkId)` returns a non-empty `metaStealthAddress`. */
export async function readIsRegistered(rpcUrl: string, identityRegistry: Hex, networkId: Hex): Promise<boolean> {
    const client = clientFor(rpcUrl)
    const metaStealthAddress = await client.readContract({
        address: identityRegistry as Address,
        abi: identityRegistryAbi,
        functionName: "identity",
        args: [networkId]
    })
    return metaStealthAddress !== "0x"
}

export async function readIssuerKeyLeaves(rpcUrl: string, approvedIssuerSet: Hex, networkId: Hex): Promise<bigint[]> {
    const leaves = await clientFor(rpcUrl).readContract({
        address: approvedIssuerSet as Address,
        abi: approvedIssuerSetAbi,
        functionName: "issuerKeysOf",
        args: [networkId]
    })
    return [...leaves]
}

/** The roots a served list must hash to and the issuer set's leaf count, all read at one block. */
export async function readChainRoots(
    rpcUrl: string,
    approvedIssuerSet: Hex,
    revocationService: Hex,
    registryId: bigint
): Promise<ChainRoots> {
    const client = clientFor(rpcUrl)
    const blockNumber = await client.getBlockNumber()
    const [approvedIssuerRoot, leafCount, revocationRoot] = await Promise.all([
        client.readContract({
            address: approvedIssuerSet as Address,
            abi: approvedIssuerSetAbi,
            functionName: "issuerSetRoot",
            blockNumber
        }),
        client.readContract({
            address: approvedIssuerSet as Address,
            abi: approvedIssuerSetAbi,
            functionName: "getLeafCount",
            blockNumber
        }),
        client.readContract({
            address: revocationService as Address,
            abi: revocationAbi,
            functionName: "getRevocationRoot",
            args: [registryId],
            blockNumber
        })
    ])
    return { approvedIssuerRoot, approvedIssuerLeafCount: Number(leafCount), revocationRoot }
}

/** Fails, rather than answering stale or empty roots, with no stack: every list check then refuses. */
export function createRootAuthority(currentStack: () => StackDescriptor | null): RootAuthority {
    return {
        currentRoots: async () => {
            const stack = currentStack()
            if (stack === null) throw new Error("no stack is scanned to read the chain's roots from")
            return readChainRoots(
                stack.rpcUrl,
                stack.approvedIssuerSet,
                stack.revocation.address,
                BigInt(stack.revocation.registryId)
            )
        }
    }
}

/** Fails, rather than answering an empty list, with no stack: issuance then refuses to go ahead. */
export function createMemberDirectory(currentStack: () => StackDescriptor | null): MemberDirectory {
    return {
        issuerKeyLeavesOf: async (networkId) => {
            const stack = currentStack()
            if (stack === null) throw new Error("no stack is scanned to check the issuer against")
            // Every scanned member is read, so a passive RPC provider cannot tell which
            // one this issuance is about; only the claimed member's answer is used.
            const reads = await Promise.allSettled(
                stack.members.map((member) =>
                    readIssuerKeyLeaves(stack.rpcUrl, stack.approvedIssuerSet, member.networkId)
                )
            )
            const claimed = stack.members.findIndex(
                (member) => member.networkId.toLowerCase() === networkId.toLowerCase()
            )
            if (claimed === -1) return []
            const read = reads[claimed]
            if (read.status === "rejected") throw read.reason
            return read.value
        }
    }
}
