import assert from "node:assert/strict"
import { test } from "node:test"
import { parseAbi, parseEther, type Address, type Hex } from "viem"
import {
    checkStealthAddress,
    computeSharedSecret,
    deriveKeys,
    generateEphemeralKey,
    getViewTag
} from "@coordination-network/identity"
import { publicClient } from "../scripts/config.ts"
import { deployAnnouncer, deployToken } from "../scripts/deploy.ts"
import { generateMetaStealthAddress } from "../scripts/1-generate-meta-stealth-address.ts"
import { generateStealthAccount } from "../scripts/2-generate-stealth-account.ts"
import { payStealthAccount } from "../scripts/3-pay-stealth-account.ts"
import { publishAnnouncement } from "../scripts/4-publish-announcement.ts"
import { scanForAnnouncement } from "../scripts/5-scan-for-payments.ts"
import { spendReceivedFunds } from "../scripts/6-spend-received-funds.ts"
import { startAnvil } from "./chain.ts"

// anvil's second funded account. The account where the stealth address owner sends their funds
const RECIPIENT: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

const DEVICE_SECRET: Hex = `0x${"01".repeat(32)}`
const OTHER_DEVICE_SECRET: Hex = `0x${"02".repeat(32)}`
const TOKEN_ID = 1n
const AMOUNT = 100n

const scopedTokenAbi = parseAbi(["function balanceOf(address account, uint256 id) view returns (uint256)"])

test("meta stealth address -> stealth address -> send -> scan -> spend", async () => {
    const anvil = await startAnvil()
    try {
        const announcerAddress = await deployAnnouncer()
        const tokenAddress = await deployToken()

        const tokenBalanceOf = (account: Address) =>
            publicClient.readContract({
                address: tokenAddress,
                abi: scopedTokenAbi,
                functionName: "balanceOf",
                args: [account, TOKEN_ID]
            })

        const keys = deriveKeys(DEVICE_SECRET)

        // 1. the receiver derives their meta stealth address
        const metaStealthAddress = generateMetaStealthAddress(DEVICE_SECRET)
        assert.equal(metaStealthAddress, `${keys.spending.publicKey}${keys.viewing.publicKey.slice(2)}`)

        // 2. the sender derives a stealth account from it, which the receiver can recognise as theirs
        const ephemeralKey = generateEphemeralKey()
        const stealthAddress = generateStealthAccount(metaStealthAddress, ephemeralKey.privateKey)
        const generatedViewTag = getViewTag(
            computeSharedSecret({ privateKey: keys.viewing.privateKey, publicKey: ephemeralKey.publicKey })
        )
        assert.ok(
            checkStealthAddress({
                stealthAddress: stealthAddress,
                ephemeralPublicKey: ephemeralKey.publicKey,
                spendingPublicKey: keys.spending.publicKey,
                viewingPrivateKey: keys.viewing.privateKey,
                viewTag: generatedViewTag
            })
        )

        // 3. the sender pays: tokens and gas money land on the stealth account
        await payStealthAccount({ stealthAddress, tokenAddress, tokenId: TOKEN_ID, amount: AMOUNT })

        // 4. the sender announces it, so the receiver can find it
        await publishAnnouncement({ metaStealthAddress, ephemeralKey, announcerAddress })
        assert.equal(await tokenBalanceOf(stealthAddress), AMOUNT)
        assert.equal(await publicClient.getBalance({ address: stealthAddress }), parseEther("0.01"))

        // 5. the receiver finds that payment
        const foundStealthAddress = await scanForAnnouncement(DEVICE_SECRET, announcerAddress)
        const otherDeviceScan = await scanForAnnouncement(OTHER_DEVICE_SECRET, announcerAddress)
        assert.equal(foundStealthAddress, stealthAddress)
        assert.equal(otherDeviceScan, null)

        // 6. the receiver spends it, proving they control the stealth account
        await spendReceivedFunds({
            ephemeralKey,
            viewingPrivateKey: keys.viewing.privateKey,
            spendingPrivateKey: keys.spending.privateKey,
            stealthAddress: stealthAddress,
            recipient: RECIPIENT,
            tokenAddress,
            tokenId: TOKEN_ID,
            amount: AMOUNT
        })
        assert.equal(await tokenBalanceOf(RECIPIENT), AMOUNT)
        assert.equal(await tokenBalanceOf(stealthAddress), 0n)
    } finally {
        anvil.kill()
    }
})
