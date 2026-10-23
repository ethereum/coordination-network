import { describe, expect, it } from "@jest/globals"
import { toHex } from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { signDelegationIfUndelegated } from "../src/delegation"

const TEST_MNEMONIC = "test test test test test test test test test test test junk"
const OWNER = privateKeyToAccount(toHex(mnemonicToAccount(TEST_MNEMONIC).getHdKey().privateKey!))
// Simple7702Account 0.8: https://etherscan.io/address/0xe6Cae83BdE06E4c305530e199D7217f42808555B
const IMPLEMENTATION = "0xe6Cae83BdE06E4c305530e199D7217f42808555B"
const CHAIN_ID = 1337
const NONCE = 3

describe("signDelegationIfUndelegated", () => {
    it("signs an authorization when the account is not yet delegated", async () => {
        const client = {
            getChainId: async () => CHAIN_ID,
            getDelegation: async () => undefined,
            getTransactionCount: async () => NONCE
        } as never

        const delegation = await signDelegationIfUndelegated({ client, account: OWNER, implementation: IMPLEMENTATION })

        expect(delegation?.authorization.address).toBe(IMPLEMENTATION)
        expect(delegation?.authorization.nonce).toBe(NONCE)
        expect(delegation?.authorization.chainId).toBe(CHAIN_ID)
    })

    it("returns undefined once the account already delegates to the implementation", async () => {
        const client = {
            getChainId: async () => CHAIN_ID,
            getDelegation: async () => IMPLEMENTATION,
            getTransactionCount: async () => NONCE
        } as never

        const delegation = await signDelegationIfUndelegated({ client, account: OWNER, implementation: IMPLEMENTATION })

        expect(delegation).toBeUndefined()
    })
})
