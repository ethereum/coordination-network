import { SemaphoreViem } from "@semaphore-protocol/data"
import { Group } from "@semaphore-protocol/group"
import { NETWORK_MEMBER_GROUP_ABI } from "./abis.ts"
import { publicClient, RPC_URL } from "./config.ts"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"

/**
 * Rebuilds the approved-member group from the chain, as it stands now.
 *
 * Removing a member needs a Merkle proof for its leaf, and no contract can produce one: Semaphore keeps
 * the tree's root, not its leaves. Rebuilt on every call rather than cached, because a cached copy is
 * only correct while you are the only party writing to the group, and here you are not.
 *
 * `@semaphore-protocol/data` returns the leaves in index order with "0" where a member was removed.
 * Passing that whole array to the `Group` constructor preserves the tree's shape: a removal zeroes its
 * leaf and leaves the slot in place, so a tree built from only the current members would put everyone
 * after the removal at the wrong index. The constructor is the only way in, since `addMember` refuses
 * a zero.
 */
export async function rebuildGroupFromChain(deployment: NetworkMemberDeployment): Promise<Group> {
    const semaphore = new SemaphoreViem(RPC_URL, {
        address: deployment.semaphore,
        // The demo's own client, rather than a second transport to the same node.
        publicClient
    })

    const members = await semaphore.getGroupMembers(deployment.groupId.toString())
    const group = new Group(members)

    // A tree that does not hash to what the chain holds yields proofs Semaphore rejects, so the
    // mismatch is caught here rather than at the transaction.
    const onChainRoot = await publicClient.readContract({
        address: deployment.group,
        abi: NETWORK_MEMBER_GROUP_ABI,
        functionName: "merkleTreeRoot"
    })
    const rebuiltRoot = BigInt(group.root)

    if (rebuiltRoot !== onChainRoot) {
        throw new Error(`rebuilt group root ${rebuiltRoot} does not match the chain's ${onChainRoot}`)
    }

    return group
}

/**
 * The membership proof `removeMember` and `exitNetwork` take. Valid against the group it was computed
 * from, so it has to be used before another membership change lands.
 */
export function siblingsFor(group: Group, commitment: bigint): bigint[] {
    const index = group.indexOf(commitment)
    if (index === -1) throw new Error(`commitment ${commitment} is not in the group`)

    return group.generateMerkleProof(index).siblings
}
