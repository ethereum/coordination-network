import { describe, expect, it } from "@jest/globals"
import {
    concatHex,
    encodeAbiParameters,
    getAddress,
    keccak256,
    pad,
    parseAbiParameters,
    size,
    slice,
    toHex,
    type Address,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

import {
    OperationType,
    buildAdmissionTransaction,
    buildSafeTransactionData,
    checkQuorum,
    encodeExecTransaction,
    encodeSafeSignatures,
    hashSafeTransaction,
    recoverSafeSigner,
    resolveMultiSend,
    signSafeTransaction,
    type GovernanceContracts,
    type NetworkMemberJoinRequest,
    type SafeContext,
    type SafeTransactionData
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

/** Five founding members, the set every transaction below is built against. */
const MEMBER_COUNT = 5

/** Five owners, deterministic keys, so the sorting assertions are meaningful. */
const OWNERS = Array.from({ length: 5 }, (_, index) => privateKeyToAccount(pad(toHex(index + 1), { size: 32 })))

/**
 * The Safe's own `getTransactionHash`, hand-encoded here straight from EIP-712 and
 * the literal type strings in the Safe contracts.
 *
 * This is a second, independent implementation, so the assertions below check the
 * package against something other than the library it uses. Comparing the SDK's
 * digest with viem's would only show that a library agrees with itself; a wrong
 * field order, a domain carrying `name` and `version`, an older version's
 * typehash, or `data` passed unhashed would all sail through. Each of those
 * produces a digest no Safe accepts.
 */
function safeTransactionHashByHand(context: SafeContext, transaction: SafeTransactionData): Hex {
    const domainSeparator = keccak256(
        encodeAbiParameters(parseAbiParameters("bytes32, uint256, address"), [
            keccak256(toHex("EIP712Domain(uint256 chainId,address verifyingContract)")),
            BigInt(context.chainId),
            context.safeAddress
        ])
    )

    const safeTxHash = keccak256(
        encodeAbiParameters(
            parseAbiParameters(
                "bytes32, address, uint256, bytes32, uint8, uint256, uint256, uint256, address, address, uint256"
            ),
            [
                keccak256(
                    toHex(
                        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
                    )
                ),
                transaction.to as Address,
                BigInt(transaction.value),
                keccak256(transaction.data as Hex),
                transaction.operation,
                BigInt(transaction.safeTxGas),
                BigInt(transaction.baseGas),
                BigInt(transaction.gasPrice),
                transaction.gasToken as Address,
                transaction.refundReceiver as Address,
                BigInt(transaction.nonce)
            ]
        )
    )

    return keccak256(concatHex(["0x1901", domainSeparator, safeTxHash]))
}

async function signAll(transaction: SafeTransactionData, count: number) {
    return Promise.all(OWNERS.slice(0, count).map((owner) => signSafeTransaction(owner, SAFE, transaction)))
}

describe("Safe transactions", () => {
    describe("hashSafeTransaction", () => {
        it("matches the digest the Safe computes in getTransactionHash", () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 7, MEMBER_COUNT)

            expect(hashSafeTransaction(SAFE, transaction)).toBe(safeTransactionHashByHand(SAFE, transaction))
        })

        it("binds the digest to the Safe, the chain and the nonce", () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 7, MEMBER_COUNT)
            const digest = hashSafeTransaction(SAFE, transaction)

            expect(hashSafeTransaction({ ...SAFE, chainId: 1 }, transaction)).not.toBe(digest)
            expect(
                hashSafeTransaction(
                    { ...SAFE, safeAddress: getAddress("0x5555555555555555555555555555555555555555") },
                    transaction
                )
            ).not.toBe(digest)
            expect(hashSafeTransaction(SAFE, { ...transaction, nonce: 8 })).not.toBe(digest)
        })
    })

    describe("buildSafeTransactionData", () => {
        it("executes a single call directly, with the gas and refund fields zeroed", () => {
            const transaction = buildSafeTransactionData(
                [{ to: CONTRACTS.registry, value: "0", data: "0x1234" }],
                SAFE,
                3
            )

            expect(transaction).toMatchObject({
                to: CONTRACTS.registry,
                value: "0",
                data: "0x1234",
                operation: OperationType.Call,
                safeTxGas: "0",
                baseGas: "0",
                gasPrice: "0",
                nonce: 3
            })
        })

        it("batches several calls as a delegate call into the canonical MultiSendCallOnly", () => {
            // Governance operations are single calls now, so batching is only a primitive here.
            const transaction = buildSafeTransactionData(
                [
                    { to: CONTRACTS.registry, value: "0", data: "0x1234" },
                    { to: CONTRACTS.governance, value: "0", data: "0x5678" }
                ],
                SAFE,
                0
            )

            expect(transaction.operation).toBe(OperationType.DelegateCall)
            expect(getAddress(transaction.to as Address)).toBe(resolveMultiSend(SAFE))
        })

        it("executes a governance operation as a plain call, with no MultiSend involved", () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 0, MEMBER_COUNT)

            expect(transaction.operation).toBe(OperationType.Call)
            expect(getAddress(transaction.to as Address)).toBe(CONTRACTS.governance)
        })

        it("batches on a chain with no canonical deployment, given an override", () => {
            // The override exists for exactly this chain, so the batch has to build without a
            // canonical deployment to look up. Only the address varies by chain; the ABI does not.
            const multiSend = getAddress("0x3333333333333333333333333333333333333333")
            const transaction = buildSafeTransactionData(
                [
                    { to: CONTRACTS.registry, value: "0", data: "0x1234" },
                    { to: CONTRACTS.governance, value: "0", data: "0x5678" }
                ],
                { ...SAFE, chainId: 987_654_321, multiSend },
                0
            )

            expect(transaction.operation).toBe(OperationType.DelegateCall)
            expect(getAddress(transaction.to as Address)).toBe(multiSend)
            expect(transaction.data).toContain("1234")
            expect(transaction.data).toContain("5678")
        })

        it("refuses an empty batch", () => {
            expect(() => buildSafeTransactionData([], SAFE, 0)).toThrow("at least one call")
        })

        it("refuses to batch for a Safe version with no published MultiSendCallOnly", () => {
            // The override skips the address lookup, so the ABI lookup is what has to refuse.
            const unknown = {
                ...SAFE,
                safeVersion: "9.9.9",
                multiSend: getAddress("0x3333333333333333333333333333333333333333")
            } as unknown as SafeContext

            expect(() =>
                buildSafeTransactionData(
                    [
                        { to: CONTRACTS.registry, value: "0", data: "0x1234" },
                        { to: CONTRACTS.governance, value: "0", data: "0x5678" }
                    ],
                    unknown,
                    0
                )
            ).toThrow("No MultiSendCallOnly deployment for Safe 9.9.9")
        })
    })

    describe("resolveMultiSend", () => {
        it("resolves the canonical deployment for the chain", () => {
            expect(resolveMultiSend(SAFE)).toMatch(/^0x[0-9a-fA-F]{40}$/)
        })

        it("prefers an explicit override", () => {
            const override = getAddress("0x4444444444444444444444444444444444444444")

            expect(resolveMultiSend({ ...SAFE, multiSend: override })).toBe(override)
        })

        it("explains itself on a chain with no canonical deployment", () => {
            expect(() => resolveMultiSend({ ...SAFE, chainId: 987_654_321 })).toThrow("Pass `multiSend` explicitly")
        })
    })

    describe("signSafeTransaction", () => {
        it("produces a 65-byte signature that recovers to the approver", async () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 0, MEMBER_COUNT)
            const [approval] = await signAll(transaction, 1)

            expect(size(approval.data as Hex)).toBe(65)
            expect(approval.signer).toBe(OWNERS[0].address)
            expect(await recoverSafeSigner(SAFE, transaction, approval.data as Hex)).toBe(OWNERS[0].address)
        })

        it("does not authorise a different transaction", async () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 0, MEMBER_COUNT)
            const [approval] = await signAll(transaction, 1)

            const other = buildAdmissionTransaction(
                CONTRACTS,
                { ...ADMISSION, semaphoreCommitment: 999n },
                SAFE,
                0,
                MEMBER_COUNT
            )

            expect(await recoverSafeSigner(SAFE, other, approval.data as Hex)).not.toBe(OWNERS[0].address)
        })
    })

    describe("encodeSafeSignatures", () => {
        it("sorts by signer address ascending, as the Safe requires", async () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 0, MEMBER_COUNT)
            const approvals = await signAll(transaction, 3)

            const packed = encodeSafeSignatures([...approvals].reverse())
            const parts = Array.from({ length: 3 }, (_, index) => slice(packed, index * 65, (index + 1) * 65))

            const recovered = await Promise.all(parts.map((part) => recoverSafeSigner(SAFE, transaction, part)))
            const ascending = [...recovered].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))

            expect(recovered).toEqual(ascending)
            expect(new Set(recovered)).toEqual(new Set(approvals.map(({ signer }) => signer)))
        })

        it("refuses the same owner counted twice", async () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 0, MEMBER_COUNT)
            const [approval] = await signAll(transaction, 1)

            expect(() => encodeSafeSignatures([approval, approval])).toThrow("Duplicate signature")
        })

        it("refuses an empty set", () => {
            expect(() => encodeSafeSignatures([])).toThrow("at least one signature")
        })
    })

    describe("checkQuorum", () => {
        const owners = OWNERS.map(({ address }) => address)

        it("counts distinct owners against the threshold", () => {
            const signers = [owners[0], owners[1]]

            expect(checkQuorum(owners, 3, signers)).toMatchObject({ hasQuorum: false, missing: 1 })
            expect(checkQuorum(owners, 3, [...signers, owners[2]])).toMatchObject({ hasQuorum: true, missing: 0 })
        })

        it("ignores duplicates and non-owners", () => {
            const outsider = getAddress("0x6666666666666666666666666666666666666666") as Address

            expect(checkQuorum(owners, 3, [owners[0], owners[0], outsider])).toMatchObject({
                hasQuorum: false,
                signers: [owners[0]],
                missing: 2
            })
        })
    })

    describe("encodeExecTransaction", () => {
        it("encodes the call anyone can submit to the Safe", async () => {
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 4, MEMBER_COUNT)
            const approvals = await signAll(transaction, 3)

            const calldata = encodeExecTransaction(SAFE, transaction, approvals)

            // `execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)`
            expect(slice(calldata, 0, 4)).toBe("0x6a761202")
            expect(calldata).toContain(encodeSafeSignatures(approvals).slice(2))
        })

        it("encodes against an older Safe's own ABI when the context names one", async () => {
            const legacy: SafeContext = { ...SAFE, safeVersion: "1.3.0" }
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, legacy, 4, MEMBER_COUNT)
            const approvals = await signAll(transaction, 3)

            // Safe kept the `execTransaction` signature across versions, so the selector is stable even
            // though the ABI, the domain and the SafeTx typehash are resolved per version.
            expect(slice(encodeExecTransaction(legacy, transaction, approvals), 0, 4)).toBe("0x6a761202")
        })

        it("refuses a Safe version that has no published singleton", async () => {
            const unknown = { ...SAFE, safeVersion: "9.9.9" } as unknown as SafeContext
            const transaction = buildAdmissionTransaction(CONTRACTS, ADMISSION, SAFE, 4, MEMBER_COUNT)
            const approvals = await signAll(transaction, 3)

            expect(() => encodeExecTransaction(unknown, transaction, approvals)).toThrow(
                "No Safe singleton deployment for version 9.9.9"
            )
        })
    })
})
