import { describe, expect, it } from "@jest/globals"
import { decodeFunctionData, getAddress, pad, type Address } from "viem"

import {
    NETWORK_MEMBER_GOVERNANCE_ABI,
    NO_REFUND,
    OperationType,
    ZERO_ADDRESS,
    admissionCall,
    buildRemovalTransaction,
    encodeAdmitMember,
    encodeRemoveMember,
    hashSafeTransaction,
    removalCall,
    type GovernanceContracts,
    type NetworkMemberJoinRequest,
    type NetworkMemberRemoval,
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

/** The member's leaf sits under these siblings in the group as it stands now. */
const REMOVAL: NetworkMemberRemoval = {
    memberNetworkId: pad("0xabcd", { size: 32 }),
    merkleProofSiblings: [1n, 2n, 3n]
}

const ADMISSION: NetworkMemberJoinRequest = {
    memberNetworkId: pad("0xabcd", { size: 32 }),
    accountKeyX: 11n,
    accountKeyY: 22n,
    semaphoreCommitment: 12_345_678_901_234_567_890n,
    governanceSigner: getAddress("0x9999999999999999999999999999999999999999")
}

const MEMBER_COUNT = 5
const NONCE = 7

describe("removal calls", () => {
    describe("encodeRemoveMember", () => {
        it("carries only the networkId, the proof and the member set it was built against", () => {
            const { functionName, args } = decodeFunctionData({
                abi: NETWORK_MEMBER_GOVERNANCE_ABI,
                data: encodeRemoveMember(REMOVAL, MEMBER_COUNT)
            })

            // No commitment and no governance signer: the orchestrator reads both from the registry,
            // so a removal cannot be pointed at another member's leaf or seat.
            expect(functionName).toBe("removeMember")
            expect(args).toEqual([REMOVAL.memberNetworkId, REMOVAL.merkleProofSiblings, BigInt(MEMBER_COUNT)])
        })

        it("carries no threshold, because the orchestrator computes it", () => {
            const removeMember = NETWORK_MEMBER_GOVERNANCE_ABI.find(
                (entry) => entry.type === "function" && entry.name === "removeMember"
            )

            expect(removeMember).toBeDefined()
            expect(removeMember?.type === "function" && removeMember.inputs.map((input) => input.name)).toEqual([
                "memberNetworkId",
                "merkleProofSiblings",
                "expectedMemberCount"
            ])
        })

        it("pins the member count, so the same removal against a different set is different calldata", () => {
            expect(encodeRemoveMember(REMOVAL, MEMBER_COUNT)).not.toBe(encodeRemoveMember(REMOVAL, MEMBER_COUNT + 1))
        })

        it("binds the proof, so a stale one cannot be swapped for a fresh one after the fact", () => {
            const recomputed = { ...REMOVAL, merkleProofSiblings: [1n, 2n, 4n] }

            expect(encodeRemoveMember(recomputed, MEMBER_COUNT)).not.toBe(encodeRemoveMember(REMOVAL, MEMBER_COUNT))
        })

        it("accepts a member whose leaf needs no siblings", () => {
            const onlyLeaf = { ...REMOVAL, merkleProofSiblings: [] }
            const { args } = decodeFunctionData({
                abi: NETWORK_MEMBER_GOVERNANCE_ABI,
                data: encodeRemoveMember(onlyLeaf, MEMBER_COUNT)
            })

            expect(args?.[1]).toEqual([])
        })
    })

    describe("removalCall", () => {
        it("targets the orchestrator and moves no value", () => {
            const call = removalCall(CONTRACTS, REMOVAL, MEMBER_COUNT)

            expect(getAddress(call.to as Address)).toBe(CONTRACTS.governance)
            expect(call.value).toBe("0")
            expect(call.data).toBe(encodeRemoveMember(REMOVAL, MEMBER_COUNT))
        })

        it("never targets the registry or the group directly", () => {
            const call = removalCall(CONTRACTS, REMOVAL, MEMBER_COUNT)

            expect(getAddress(call.to as Address)).not.toBe(CONTRACTS.registry)
        })
    })

    describe("admissionCall", () => {
        it("targets the orchestrator with the admission calldata and no value", () => {
            const call = admissionCall(CONTRACTS, ADMISSION, MEMBER_COUNT)

            expect(getAddress(call.to as Address)).toBe(CONTRACTS.governance)
            expect(call.value).toBe("0")
            expect(call.data).toBe(encodeAdmitMember(ADMISSION, MEMBER_COUNT))
        })

        it("is the same call the transaction builder wraps, so assembling by hand cannot drift", () => {
            const call = admissionCall(CONTRACTS, ADMISSION, MEMBER_COUNT)
            const transaction = buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT)

            expect(call.data).not.toBe(transaction.data)
            expect(getAddress(call.to as Address)).toBe(getAddress(transaction.to as Address))
        })
    })

    describe("buildRemovalTransaction", () => {
        it("is one plain call to the orchestrator, refunding nobody", () => {
            const transaction = buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT)

            expect(getAddress(transaction.to as Address)).toBe(CONTRACTS.governance)
            expect(transaction.operation).toBe(OperationType.Call)
            expect(transaction.value).toBe("0")
            expect(transaction.nonce).toBe(NONCE)
            expect(transaction).toMatchObject(NO_REFUND)
            expect(transaction.gasToken).toBe(ZERO_ADDRESS)
            expect(transaction.refundReceiver).toBe(ZERO_ADDRESS)
        })

        it("is a pure function of its inputs, so independent approvers build the same bytes", () => {
            const built = buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT)
            const rebuilt = buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT)

            expect(hashSafeTransaction(SAFE, rebuilt)).toBe(hashSafeTransaction(SAFE, built))
        })

        it("hashes differently once the nonce or the member set moves", () => {
            const digest = hashSafeTransaction(
                SAFE,
                buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT)
            )

            expect(
                hashSafeTransaction(SAFE, buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE + 1, MEMBER_COUNT))
            ).not.toBe(digest)
            expect(
                hashSafeTransaction(SAFE, buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT - 1))
            ).not.toBe(digest)
        })

        it("does not collide with an admission at the same nonce", () => {
            const removal = buildRemovalTransaction(CONTRACTS, REMOVAL, SAFE, NONCE, MEMBER_COUNT)

            expect(removal.data).not.toBe(encodeRemoveMember({ ...REMOVAL, merkleProofSiblings: [] }, MEMBER_COUNT))
        })
    })
})
