import { getAddress, hexToBytes } from "viem"
import { createKeyCipher } from "../../src/keyCipher.ts"
import { Announcement } from "../../src/types.ts"

export const keyCipher = createKeyCipher({
    encryptionKey: hexToBytes(`0x${"0e".repeat(32)}`),
    lookupHashKey: hexToBytes(`0x${"0f".repeat(32)}`)
})

export const key1 = {
    networkId: `0x${"01".repeat(32)}`,
    spendingPublicKey: `0x02${"11".repeat(32)}`,
    viewingPrivateKey: `0x${"aa".repeat(32)}`
} as const
export const key2 = {
    networkId: `0x${"02".repeat(32)}`,
    spendingPublicKey: `0x03${"22".repeat(32)}`,
    viewingPrivateKey: `0x${"bb".repeat(32)}`
} as const

/** A decoded Announcement, distinguished only by logIndex so several can coexist in one block. */
export function announcement(logIndex: number): Announcement {
    return {
        schemeId: 1n,
        stealthAddress: getAddress(`0x${"ab".repeat(19)}${logIndex.toString().padStart(2, "0")}`),
        caller: `0x${"44".repeat(20)}`,
        ephemeralPublicKey: `0x02${"55".repeat(32)}`,
        metadata: "0xff",
        blockNumber: 10n,
        txHash: `0x${"66".repeat(32)}`,
        logIndex
    }
}
