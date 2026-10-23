import { parseAbi, parseEther, type Address } from "viem"
import { publicClient, walletClient } from "./config.ts"

const scopedTokenAbi = parseAbi(["function mint(address account, uint256 id, uint256 amount)"])

/** Step 3, sender. Funds the stealth account. */
export async function payStealthAccount({
    stealthAddress,
    tokenAddress,
    tokenId,
    amount
}: {
    stealthAddress: Address
    tokenAddress: Address
    tokenId: bigint
    amount: bigint
}) {
    // 1. Mint token to account. Equivalent to network member minting to user
    const mintTransactionHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: scopedTokenAbi,
        functionName: "mint",
        args: [stealthAddress, tokenId, amount]
    })
    await publicClient.waitForTransactionReceipt({ hash: mintTransactionHash })

    // 2. A fresh account holds no ETH, so it needs funding in order to send funds in step 6
    // Production accounts are sponsored with the Semaphore paymaster.
    const gasFundingTransactionHash = await walletClient.sendTransaction({
        to: stealthAddress,
        value: parseEther("0.01")
    })
    await publicClient.waitForTransactionReceipt({ hash: gasFundingTransactionHash })
}
