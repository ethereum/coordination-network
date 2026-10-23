import { describe, expect, it } from "@jest/globals"
import { decodeFunctionData, getAddress, pad, size, slice, type Address, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

import {
    NETWORK_MEMBER_GOVERNANCE_ABI,
    buildAdmissionTransaction,
    encodeApproveHash,
    encodeExecTransaction,
    encodeSafeSignatures,
    hashSafeTransaction,
    onChainApproval,
    signSafeTransaction,
    type GovernanceContracts,
    type NetworkMemberJoinRequest,
    type SafeContext
} from "../src"

const SAFE: SafeContext = {
    safeAddress: getAddress("0x1111111111111111111111111111111111111111"),
    chainId: 11_155_111
}

const CONTRACTS: GovernanceContracts = {
    governance: getAddress("0x2222222222222222222222222222222222222222"),
    registry: getAddress("0x3333333333333333333333333333333333333333")
}

const ADMISSION: NetworkMemberJoinRequest = {
    memberNetworkId: pad("0xabcd", { size: 32 }),
    accountKeyX: 11n,
    accountKeyY: 22n,
    semaphoreCommitment: 12_345_678_901_234_567_890n,
    governanceSigner: getAddress("0x9999999999999999999999999999999999999999"),
    metadataURI: "<vetting material URL>"
}

const MEMBER_COUNT = 5
const TRANSACTION = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 7, MEMBER_COUNT)

describe("on-chain approvals", () => {
    describe("encodeApproveHash", () => {
        it("encodes the approver's own call, bound to one exact transaction", () => {
            const txHash = hashSafeTransaction(SAFE, TRANSACTION)
            const calldata = encodeApproveHash(SAFE, txHash)

            // `approveHash(bytes32)`
            expect(slice(calldata, 0, 4)).toBe("0xd4d9bdcd")
            expect(calldata).toContain(txHash.slice(2))
        })

        it("binds an approval to one candidate, so it cannot count for another", () => {
            const other = buildAdmissionTransaction(
                CONTRACTS,
                { ...ADMISSION, accountKeyX: 33n },
                SAFE,
                7,
                MEMBER_COUNT
            )

            expect(encodeApproveHash(SAFE, hashSafeTransaction(SAFE, other))).not.toBe(
                encodeApproveHash(SAFE, hashSafeTransaction(SAFE, TRANSACTION))
            )
        })
    })

    describe("onChainApproval", () => {
        const OWNER = getAddress("0x4444444444444444444444444444444444444444") as Address

        it("names the approver and carries no signature material", () => {
            const approval = onChainApproval(OWNER)

            expect(approval.signer).toBe(OWNER)
            expect(size(approval.data as Hex)).toBe(65)
            // r is the owner address, s is empty, v is 1: the Safe reads the approval from its storage.
            expect(BigInt(slice(approval.data as Hex, 0, 32))).toBe(BigInt(OWNER))
            expect(BigInt(slice(approval.data as Hex, 32, 64))).toBe(0n)
            expect(slice(approval.data as Hex, 64, 65)).toBe("0x01")
        })

        it("packs through the same path as signatures made off chain", () => {
            const owners = [
                getAddress("0x0000000000000000000000000000000000000aaa"),
                getAddress("0x0000000000000000000000000000000000000bbb")
            ] as Address[]

            const packed = encodeSafeSignatures(owners.map(onChainApproval))

            expect(size(packed)).toBe(130)
            // Sorted by signer, as the Safe requires.
            expect(BigInt(slice(packed, 0, 32))).toBeLessThan(BigInt(slice(packed, 65, 97)))
        })

        it("mixes with a signature made off chain in one transaction", async () => {
            const signer = privateKeyToAccount(pad("0x01", { size: 32 }))
            const signed = await signSafeTransaction(signer, SAFE, TRANSACTION)
            const approved = onChainApproval(getAddress("0x0000000000000000000000000000000000000aaa"))

            const calldata = encodeExecTransaction(SAFE, TRANSACTION, [signed, approved])
            const { args } = decodeFunctionData({
                abi: [
                    ...NETWORK_MEMBER_GOVERNANCE_ABI,
                    {
                        type: "function",
                        name: "execTransaction",
                        stateMutability: "payable",
                        inputs: [
                            { name: "to", type: "address" },
                            { name: "value", type: "uint256" },
                            { name: "data", type: "bytes" },
                            { name: "operation", type: "uint8" },
                            { name: "safeTxGas", type: "uint256" },
                            { name: "baseGas", type: "uint256" },
                            { name: "gasPrice", type: "uint256" },
                            { name: "gasToken", type: "address" },
                            { name: "refundReceiver", type: "address" },
                            { name: "signatures", type: "bytes" }
                        ],
                        outputs: [{ name: "success", type: "bool" }]
                    }
                ],
                data: calldata
            })

            expect(size(args?.[9] as Hex)).toBe(130)
        })
    })
})
