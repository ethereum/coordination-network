import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"

export const RPC_URL = "http://127.0.0.1:8545"

// anvil's first funded account, whose key is public: never fund it on a real chain.
// Acts as the sender and deployer
const SENDER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })

export const walletClient = createWalletClient({
    account: privateKeyToAccount(SENDER_PRIVATE_KEY),
    chain: foundry,
    transport: http(RPC_URL)
})
