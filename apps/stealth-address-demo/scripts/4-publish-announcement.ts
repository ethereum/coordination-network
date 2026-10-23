import { parseAbi, toHex, type Address, type Hex } from "viem"
import {
    computeSharedSecret,
    decodeMetaStealthAddress,
    ERC_5564_SCHEME_ID,
    getViewTag,
    Secp256k1Keypair
} from "@coordination-network/identity"
import { publicClient, walletClient } from "./config.ts"
import { generateStealthAccount } from "./2-generate-stealth-account.ts"

const announcerAbi = parseAbi([
    "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"
])

/** Step 4, sender. Publishes the announcement the receiver scans for in step 5. */
export async function publishAnnouncement({
    metaStealthAddress,
    ephemeralKey,
    announcerAddress
}: {
    metaStealthAddress: Hex
    ephemeralKey: Secp256k1Keypair
    announcerAddress: Address
}) {
    // 1. The view tag is one byte of the shared secret, letting the receiver skip most announcements
    const { viewingPublicKey } = decodeMetaStealthAddress(metaStealthAddress)
    const viewTag = getViewTag(
        computeSharedSecret({ privateKey: ephemeralKey.privateKey, publicKey: viewingPublicKey })
    )

    // 2. Announce the account and the ephemeral key the receiver needs to recognise it
    const stealthAddress = generateStealthAccount(metaStealthAddress, ephemeralKey.privateKey)
    const announceTransactionHash = await walletClient.writeContract({
        address: announcerAddress,
        abi: announcerAbi,
        functionName: "announce",
        args: [BigInt(ERC_5564_SCHEME_ID), stealthAddress, ephemeralKey.publicKey, toHex(viewTag, { size: 1 })]
    })
    await publicClient.waitForTransactionReceipt({ hash: announceTransactionHash })
}
