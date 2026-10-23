import { Address, PublicClient, createPublicClient, http } from "viem"
import { ApprovedIssuerSet } from "@coordination-network/credential"

/** The `ApprovedIssuerSet` fragments this service reads, inlined like `revocation.ts` does. */
const APPROVED_ISSUER_SET_ABI = [
    {
        type: "function",
        name: "getLeafCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "getLeaves",
        stateMutability: "view",
        inputs: [
            { name: "start", type: "uint256" },
            { name: "end", type: "uint256" }
        ],
        outputs: [{ name: "leaves", type: "uint256[]" }]
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
        name: "getSize",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "isValidIssuerSetRoot",
        stateMutability: "view",
        inputs: [{ name: "root", type: "uint256" }],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "isApprovedIssuerKey",
        stateMutability: "view",
        inputs: [{ name: "leaf", type: "uint256" }],
        outputs: [{ type: "bool" }]
    }
] as const

/** How many leaves one `getLeaves` page reads, mirroring `ApprovedIssuerSet.fromContract`'s own paging. */
const ISSUER_SET_PAGE_SIZE = 1000

/**
 * What `/v1/issuers` and `/v1/verify` need from wherever the approved-issuer set lives: the leaves
 * a wallet rebuilds from and the root served beside them, plus the chain's own validity check for a root a
 * presentation carries (`revocation.ts`'s `RevocationBacking` is the same shape for the same reason).
 */
export interface IssuerSetBacking {
    address?: Address
    /** `size` is the set's live key count (`getSize`), not `leaves.length`: a retired key leaves its
     *  physical slot in place, so the two diverge once anything has ever been retired. */
    read(): Promise<{ leaves: bigint[]; root: bigint; blockNumber: bigint; size: number }>
    isValidRoot(root: bigint): Promise<boolean>
}

/**
 * Chain-backed: `getLeafCount`, every `getLeaves` page and `issuerSetRoot` are all read at one pinned
 * block, so a mid-read publish can't mix two chain states into a root that never existed.
 * `isValidRoot` defers to the contract's own window rather than comparing against that pinned read,
 * since a verifier may see a presentation built against an earlier root still inside `rootDuration`.
 */
export function buildChainIssuerSet(address: Address, rpcUrl: string): IssuerSetBacking {
    const client: Pick<PublicClient, "readContract" | "getBlockNumber"> = createPublicClient({
        transport: http(rpcUrl)
    })

    return {
        address,
        async read() {
            // Not the polling-interval-cached read: a re-read reacting to a just-landed publish must
            // not pin to a block from before that publish because viem served a stale getBlockNumber.
            const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
            const leafCount = Number(
                await client.readContract({
                    address,
                    abi: APPROVED_ISSUER_SET_ABI,
                    functionName: "getLeafCount",
                    blockNumber
                })
            )

            const pages: bigint[][] = []
            for (let start = 0; start < leafCount; start += ISSUER_SET_PAGE_SIZE) {
                const end = Math.min(start + ISSUER_SET_PAGE_SIZE, leafCount)
                const page = await client.readContract({
                    address,
                    abi: APPROVED_ISSUER_SET_ABI,
                    functionName: "getLeaves",
                    args: [BigInt(start), BigInt(end)],
                    blockNumber
                })
                pages.push([...page])
            }

            const root = await client.readContract({
                address,
                abi: APPROVED_ISSUER_SET_ABI,
                functionName: "issuerSetRoot",
                blockNumber
            })

            const size = await client.readContract({
                address,
                abi: APPROVED_ISSUER_SET_ABI,
                functionName: "getSize",
                blockNumber
            })

            return { leaves: pages.flat(), root, blockNumber, size: Number(size) }
        },
        async isValidRoot(root: bigint) {
            return client.readContract({
                address,
                abi: APPROVED_ISSUER_SET_ABI,
                functionName: "isValidIssuerSetRoot",
                args: [root]
            })
        }
    }
}

/** Default backing for the Node scenarios: today's plain array of signing keys, never touching a chain. */
export function createInMemoryIssuerSet(keys: [bigint, bigint][]): IssuerSetBacking {
    const set = new ApprovedIssuerSet(keys)

    return {
        async read() {
            return { leaves: set.leafSlots, root: set.root, blockNumber: 0n, size: set.leafSlots.length }
        },
        async isValidRoot(root: bigint) {
            return root === set.root
        }
    }
}
