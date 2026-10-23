import { createWalletClient, http, parseAbi, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { generateStealthPrivateKey, Secp256k1Keypair } from "@coordination-network/identity"
import { publicClient, RPC_URL } from "./config.ts"

const scopedTokenAbi = parseAbi([
    "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)"
])

/** Step 6, receiver. Recovers the stealth account's private key, then spends from it. */
export async function spendReceivedFunds({
    ephemeralKey,
    viewingPrivateKey,
    spendingPrivateKey,
    stealthAddress,
    recipient,
    tokenAddress,
    tokenId,
    amount
}: {
    ephemeralKey: Secp256k1Keypair
    viewingPrivateKey: Hex
    spendingPrivateKey: Hex
    stealthAddress: Address
    recipient: Address
    tokenAddress: Address
    tokenId: bigint
    amount: bigint
}) {
    const stealthPrivateKey = generateStealthPrivateKey({
        ephemeralPublicKey: ephemeralKey.publicKey,
        viewingPrivateKey,
        spendingPrivateKey
    })

    const stealthWalletClient = createWalletClient({
        account: privateKeyToAccount(stealthPrivateKey),
        chain: foundry,
        transport: http(RPC_URL)
    })

    const transactionHash = await stealthWalletClient.writeContract({
        address: tokenAddress,
        abi: scopedTokenAbi,
        functionName: "safeTransferFrom",
        args: [stealthAddress, recipient, tokenId, amount, "0x"]
    })
    await publicClient.waitForTransactionReceipt({ hash: transactionHash })

    return { transactionHash, from: stealthAddress, to: recipient }
}
