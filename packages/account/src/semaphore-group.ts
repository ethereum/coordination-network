import { Group } from "@semaphore-protocol/group"
import { Address, createPublicClient, http, parseAbiItem } from "viem"

const REMOVED_MEMBER = 0n

const MEMBERSHIP_EVENTS = [
    parseAbiItem(
        "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)"
    ),
    parseAbiItem(
        "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)"
    ),
    parseAbiItem(
        "event MemberUpdated(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 newIdentityCommitment, uint256 merkleTreeRoot)"
    ),
    parseAbiItem(
        "event MemberRemoved(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)"
    )
]

const GET_MERKLE_TREE_ROOT = parseAbiItem("function getMerkleTreeRoot(uint256 groupId) view returns (uint256)")

export async function fetchPaymasterSemaphoreGroup({
    rpcUrl,
    semaphoreContract,
    groupId,
    startBlock,
    blockScanWindowSize
}: {
    rpcUrl: string
    semaphoreContract: Address
    groupId: bigint
    startBlock: bigint
    blockScanWindowSize: bigint
}): Promise<Group> {
    const publicClient = createPublicClient({ transport: http(rpcUrl) })
    const latestBlock = await publicClient.getBlockNumber()
    const members: bigint[] = []

    for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += blockScanWindowSize) {
        const windowEnd = fromBlock + blockScanWindowSize - 1n
        const toBlock = windowEnd > latestBlock ? latestBlock : windowEnd
        const logs = await publicClient.getLogs({
            address: semaphoreContract,
            events: MEMBERSHIP_EVENTS,
            fromBlock,
            toBlock,
            strict: true
        })

        for (const log of logs) {
            if (log.args.groupId !== groupId) continue

            if (log.eventName === "MemberAdded") {
                members[Number(log.args.index)] = log.args.identityCommitment
            }
            if (log.eventName === "MembersAdded") {
                log.args.identityCommitments.forEach((identityCommitment, offset) => {
                    members[Number(log.args.startIndex) + offset] = identityCommitment
                })
            }
            if (log.eventName === "MemberUpdated") {
                members[Number(log.args.index)] = log.args.newIdentityCommitment
            }
            if (log.eventName === "MemberRemoved") {
                members[Number(log.args.index)] = REMOVED_MEMBER
            }
        }
    }

    const group = new Group(members)
    const merkleTreeRoot = await publicClient.readContract({
        address: semaphoreContract,
        abi: [GET_MERKLE_TREE_ROOT],
        functionName: "getMerkleTreeRoot",
        args: [groupId],
        blockNumber: latestBlock
    })
    if (group.root !== merkleTreeRoot) {
        throw new Error(`rebuilt root ${group.root} of group ${groupId} does not match the chain's ${merkleTreeRoot}.`)
    }

    return group
}
