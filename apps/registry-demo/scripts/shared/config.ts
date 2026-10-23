import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem"
import { mnemonicToAccount, type HDAccount } from "viem/accounts"
import { foundry } from "viem/chains"

export const RPC_URL = "http://127.0.0.1:8546"
export const DEMO_CHAIN = { ...foundry, name: "Coordination Network Registry Demo" } as const

export const POSEIDON_T3 = "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" as const
export const POSEIDON_T4 = "0x4443338EF595F44e0121df4C21102677B142ECF0" as const

/** Anvil's deterministic mnemonic, so every role below is a funded account on a fresh node. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"

/**
 * Who holds which key in the demo. The network member registry reads `msg.sender` on every write, so
 * each role has to be a distinct account: the contracts tell them apart by address and nothing else.
 *
 * A member's auth key and its governance signer must differ, which `requestToJoin` enforces. The auth
 * key is a hot key that writes the member's own record; the governance signer is a seat at the Safe.
 */
export const roles = {
    deployer: account(0),
    founders: [
        { auth: account(1), governanceSigner: account(2) },
        { auth: account(3), governanceSigner: account(4) },
        { auth: account(5), governanceSigner: account(6) }
    ],
    alice: { auth: account(7), governanceSigner: account(8) },
    bob: { auth: account(9), governanceSigner: account(10) },
    /**
     * An account with no part in the network: not a member, not a Safe owner, not in the group.
     * It submits the identity registry writes, which read no sender at all.
     */
    submitter: account(11)
}

export const publicClient = createPublicClient({ chain: DEMO_CHAIN, transport: http(RPC_URL) })

export const walletClient = createWalletClient({ chain: DEMO_CHAIN, transport: http(RPC_URL) })

/** The nth account Anvil funds at startup. */
function account(index: number) {
    return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index })
}

/** Sends a transaction and waits for it, failing loudly on a revert. */
export async function send(transaction: { account: HDAccount; to: Address; data: Hex; value?: bigint }) {
    const hash = await walletClient.sendTransaction({ ...transaction, chain: DEMO_CHAIN })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`)

    return receipt
}
