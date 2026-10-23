import { parseAbi, type Address } from "viem"
import { config } from "./config.ts"

const tokenAbi = parseAbi([
    "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[] balances)"
])

export type AccountBalance = { stealthAddress: Address; tokenId: bigint; balance: bigint }

/** What each stealth account holds of each scoped token type, one entry per pair. */
export async function fetchBalances(
    stealthAddresses: Array<Address>,
    tokenIds: Array<bigint>
): Promise<Array<AccountBalance>> {
    if (stealthAddresses.length === 0) return []

    // 1. `balanceOfBatch` calls balanceOf(accounts[i], ids[i]) and returns a pairwise result. For example,
    // accounts [A, B] and ids [1, 2] give you two answers — A's balance of 1, and B's balance of 2.
    // 2. Because we want to get the balance of every account against every token type, we scan every account against
    // every id. For example, we expand two accounts and two ids into four positions — [A, A, B, B] and [1, 2, 1, 2].
    const requestedBalances = stealthAddresses.flatMap((stealthAddress) =>
        tokenIds.map((tokenId) => ({ stealthAddress, tokenId }))
    )

    // returns the owner's balance of the token types requested (i.e. balance for each (owner, id) pair)
    const balances = await config.client.readContract({
        address: config.token,
        abi: tokenAbi,
        functionName: "balanceOfBatch",
        args: [
            requestedBalances.map((requested) => requested.stealthAddress),
            requestedBalances.map((requested) => requested.tokenId)
        ]
    })

    return requestedBalances.map((requested, index) => ({ ...requested, balance: balances[index] }))
}
