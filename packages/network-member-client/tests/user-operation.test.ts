import { createServer } from "node:http"
import type { Server } from "node:http"
import { describe, expect, it, jest } from "@jest/globals"
import {
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    type Account,
    type Address,
    type Chain,
    type Hex,
    type Log,
    type PublicClient,
    type SignedAuthorization,
    type Transport,
    type TransactionReceipt,
    type WalletClient
} from "viem"
import { entryPoint08Abi, getUserOperationHash } from "viem/account-abstraction"
import { BundlerRpcSubmitter, EntryPointSubmitter, parseUserOperationReceipt } from "../src/user-operation"
import type { SponsoredUserOperation } from "../src/user-operation"

const ENTRY_POINT = `0x${"44".repeat(20)}` as Address
const SENDER = `0x${"55".repeat(20)}` as Address
const PAYMASTER = `0x${"66".repeat(20)}` as Address
const CHAIN_ID = 31337

const AUTHORIZATION: SignedAuthorization = {
    address: `0x${"77".repeat(20)}` as Address,
    chainId: CHAIN_ID,
    nonce: 2,
    r: `0x${"01".repeat(32)}` as Hex,
    s: `0x${"02".repeat(32)}` as Hex,
    yParity: 0
}

function operation(overrides: Partial<SponsoredUserOperation> = {}): SponsoredUserOperation {
    return {
        sender: SENDER,
        nonce: 9n,
        factory: "0x7702",
        callData: "0xabcd" as Hex,
        callGasLimit: 700_000n,
        verificationGasLimit: 500_000n,
        preVerificationGas: 100_000n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        paymaster: PAYMASTER,
        paymasterVerificationGasLimit: 600_000n,
        paymasterPostOpGasLimit: 50_000n,
        paymasterData: "0xef01" as Hex,
        authorization: AUTHORIZATION,
        signature: "0x1234" as Hex,
        ...overrides
    }
}

/** A `Log`'s bookkeeping fields, real enough to satisfy the type, irrelevant to what these tests assert. */
function baseLog(fields: { address: Address; data: Hex; topics: ReturnType<typeof encodeEventTopics> }): Log {
    return {
        blockHash: `0x${"00".repeat(32)}` as Hex,
        blockNumber: 1n,
        logIndex: 0,
        transactionHash: `0x${"aa".repeat(32)}` as Hex,
        transactionIndex: 0,
        removed: false,
        ...fields,
        topics: fields.topics as Log["topics"]
    }
}

function userOperationEventLog(args: {
    userOpHash: Hex
    sender: Address
    paymaster: Address
    nonce: bigint
    success: boolean
    actualGasCost: bigint
    actualGasUsed: bigint
}): Log {
    return baseLog({
        address: ENTRY_POINT,
        topics: encodeEventTopics({ abi: entryPoint08Abi, eventName: "UserOperationEvent", args }),
        data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
            [args.nonce, args.success, args.actualGasCost, args.actualGasUsed]
        )
    })
}

function userOperationRevertReasonLog(args: {
    userOpHash: Hex
    sender: Address
    nonce: bigint
    revertReason: Hex
}): Log {
    return baseLog({
        address: ENTRY_POINT,
        topics: encodeEventTopics({
            abi: entryPoint08Abi,
            eventName: "UserOperationRevertReason",
            args: { userOpHash: args.userOpHash, sender: args.sender }
        }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [args.nonce, args.revertReason])
    })
}

const USER_OP_HASH = `0x${"99".repeat(32)}` as Hex

describe("parseUserOperationReceipt", () => {
    function receipt(logs: Log[]): TransactionReceipt {
        return { transactionHash: `0x${"bb".repeat(32)}` as Hex, logs } as TransactionReceipt
    }

    it("parses a successful UserOperationEvent", () => {
        const transactionReceipt = receipt([
            userOperationEventLog({
                userOpHash: USER_OP_HASH,
                sender: SENDER,
                paymaster: PAYMASTER,
                nonce: 9n,
                success: true,
                actualGasCost: 555n,
                actualGasUsed: 111n
            })
        ])

        const result = parseUserOperationReceipt(transactionReceipt, entryPoint08Abi, USER_OP_HASH)

        expect(result).toEqual({
            transactionHash: transactionReceipt.transactionHash,
            success: true,
            actualGasCost: 555n,
            actualGasUsed: 111n,
            revertReason: undefined
        })
    })

    it("carries the raw UserOperationRevertReason data when the operation failed", () => {
        const revertReason = `0x${"cd".repeat(4)}` as Hex
        const transactionReceipt = receipt([
            userOperationEventLog({
                userOpHash: USER_OP_HASH,
                sender: SENDER,
                paymaster: PAYMASTER,
                nonce: 9n,
                success: false,
                actualGasCost: 555n,
                actualGasUsed: 111n
            }),
            userOperationRevertReasonLog({ userOpHash: USER_OP_HASH, sender: SENDER, nonce: 9n, revertReason })
        ])

        const result = parseUserOperationReceipt(transactionReceipt, entryPoint08Abi, USER_OP_HASH)

        expect(result.success).toBe(false)
        expect(result.revertReason).toBe(revertReason)
    })

    it("ignores logs for a different userOpHash in the same transaction", () => {
        const otherHash = `0x${"11".repeat(32)}` as Hex
        const transactionReceipt = receipt([
            userOperationEventLog({
                userOpHash: otherHash,
                sender: SENDER,
                paymaster: PAYMASTER,
                nonce: 1n,
                success: false,
                actualGasCost: 1n,
                actualGasUsed: 1n
            }),
            userOperationEventLog({
                userOpHash: USER_OP_HASH,
                sender: SENDER,
                paymaster: PAYMASTER,
                nonce: 9n,
                success: true,
                actualGasCost: 555n,
                actualGasUsed: 111n
            })
        ])

        const result = parseUserOperationReceipt(transactionReceipt, entryPoint08Abi, USER_OP_HASH)

        expect(result.success).toBe(true)
        expect(result.actualGasCost).toBe(555n)
    })

    it("leaves revertReason undefined when the operation failed with no UserOperationRevertReason log", () => {
        const transactionReceipt = receipt([
            userOperationEventLog({
                userOpHash: USER_OP_HASH,
                sender: SENDER,
                paymaster: PAYMASTER,
                nonce: 9n,
                success: false,
                actualGasCost: 555n,
                actualGasUsed: 111n
            })
        ])

        const result = parseUserOperationReceipt(transactionReceipt, entryPoint08Abi, USER_OP_HASH)

        expect(result.success).toBe(false)
        expect(result.revertReason).toBeUndefined()
    })

    it("throws when no UserOperationEvent matches the hash", () => {
        const transactionReceipt = receipt([])

        expect(() => parseUserOperationReceipt(transactionReceipt, entryPoint08Abi, USER_OP_HASH)).toThrow(
            new RegExp(USER_OP_HASH)
        )
    })
})

type EntryPointChainClient = Pick<WalletClient<Transport, Chain, Account>, "account" | "chain" | "sendTransaction"> &
    Pick<PublicClient, "waitForTransactionReceipt">

interface SendCall {
    to: Address
    data: Hex
    authorizationList: readonly SignedAuthorization[]
}

function fakeEntryPointClient(
    sendTransaction: (call: SendCall) => Promise<Hex>,
    waitForTransactionReceipt: (call: { hash: Hex }) => Promise<TransactionReceipt> = () => {
        throw new Error("waitForTransactionReceipt not stubbed")
    }
): EntryPointChainClient {
    return {
        account: { address: `0x${"33".repeat(20)}` as Address },
        chain: { id: CHAIN_ID },
        sendTransaction,
        waitForTransactionReceipt
    } as unknown as EntryPointChainClient
}

describe("EntryPointSubmitter", () => {
    it("sends handleOps with the packed operation, the account as beneficiary, and the authorizationList", async () => {
        const sendTransaction = jest.fn<(call: SendCall) => Promise<Hex>>(async () => `0x${"dd".repeat(32)}` as Hex)
        const client = fakeEntryPointClient(sendTransaction)
        const submitter = new EntryPointSubmitter(client, ENTRY_POINT)
        const op = operation()

        const hash = await submitter.send(op)

        expect(hash).toBe(
            getUserOperationHash({
                chainId: CHAIN_ID,
                entryPointAddress: ENTRY_POINT,
                entryPointVersion: "0.8",
                userOperation: op
            })
        )
        expect(sendTransaction).toHaveBeenCalledTimes(1)
        const [call] = sendTransaction.mock.calls[0]
        expect(call.to).toBe(ENTRY_POINT)
        expect(call.authorizationList).toEqual([AUTHORIZATION])

        const decoded = decodeFunctionData({ abi: entryPoint08Abi, data: call.data })
        expect(decoded.functionName).toBe("handleOps")
        const [ops, beneficiary] = decoded.args as [unknown[], Address]
        expect(ops).toHaveLength(1)
        expect(beneficiary).toBe(client.account.address)
    })

    it("waits for the transaction it sent and parses the receipt for that userOpHash", async () => {
        const bundleTxHash = `0x${"dd".repeat(32)}` as Hex
        const sendTransaction = jest.fn<(call: SendCall) => Promise<Hex>>(async () => bundleTxHash)
        const op = operation()
        const hash = getUserOperationHash({
            chainId: CHAIN_ID,
            entryPointAddress: ENTRY_POINT,
            entryPointVersion: "0.8",
            userOperation: op
        })
        const waitForTransactionReceipt = jest.fn<(call: { hash: Hex }) => Promise<TransactionReceipt>>(
            async () =>
                ({
                    transactionHash: bundleTxHash,
                    logs: [
                        userOperationEventLog({
                            userOpHash: hash,
                            sender: SENDER,
                            paymaster: PAYMASTER,
                            nonce: 9n,
                            success: true,
                            actualGasCost: 42n,
                            actualGasUsed: 21n
                        })
                    ]
                }) as TransactionReceipt
        )
        const client = fakeEntryPointClient(sendTransaction, waitForTransactionReceipt)
        const submitter = new EntryPointSubmitter(client, ENTRY_POINT)

        await submitter.send(op)
        const receipt = await submitter.waitForReceipt(hash)

        expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: bundleTxHash })
        expect(receipt).toEqual({
            transactionHash: bundleTxHash,
            success: true,
            actualGasCost: 42n,
            actualGasUsed: 21n,
            revertReason: undefined
        })
    })

    it("throws when asked to wait for a userOpHash it never sent", async () => {
        const client = fakeEntryPointClient(jest.fn<(call: SendCall) => Promise<Hex>>())
        const submitter = new EntryPointSubmitter(client, ENTRY_POINT)

        await expect(submitter.waitForReceipt(USER_OP_HASH)).rejects.toThrow(new RegExp(USER_OP_HASH))
    })
})

describe("BundlerRpcSubmitter", () => {
    async function withFakeBundler(
        respond: (body: { method: string; params: unknown[]; id: unknown }) => unknown,
        run: (url: string) => Promise<void>
    ): Promise<void> {
        const server: Server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on("data", (chunk: Buffer) => chunks.push(chunk))
            req.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
                const result = respond(body)
                res.setHeader("content-type", "application/json")
                // The synthetic logs below carry bigint bookkeeping fields (blockNumber and
                // friends); BigInt(decimalString) parses them back fine on viem's side.
                const bigintSafe = (_key: string, value: unknown) =>
                    typeof value === "bigint" ? value.toString() : value
                res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }, bigintSafe))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        const { port } = server.address() as { port: number }
        try {
            await run(`http://127.0.0.1:${port}`)
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }

    it("sends eth_sendUserOperation with the formatted operation and entryPoint, returning the bundler's hash", async () => {
        let request: { method: string; params: unknown[] } | undefined
        const returnedHash = `0x${"ee".repeat(32)}` as Hex
        const op = operation()

        await withFakeBundler(
            (body) => {
                request = body
                return returnedHash
            },
            async (url) => {
                const submitter = new BundlerRpcSubmitter(url, ENTRY_POINT)
                const hash = await submitter.send(op)
                expect(hash).toBe(returnedHash)
            }
        )

        expect(request?.method).toBe("eth_sendUserOperation")
        const [formatted, entryPoint] = request?.params as [Record<string, unknown>, Address]
        expect(entryPoint).toBe(ENTRY_POINT)
        expect(formatted.factory).toBe("0x7702")
        expect(formatted.eip7702Auth).toMatchObject({ address: AUTHORIZATION.address })
    })

    it("rejects when the bundler returns a JSON-RPC error for eth_sendUserOperation", async () => {
        const server: Server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on("data", (chunk: Buffer) => chunks.push(chunk))
            req.on("end", () => {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
                res.setHeader("content-type", "application/json")
                res.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: body.id,
                        error: { code: -32521, message: "AA24 signature error" }
                    })
                )
            })
        })
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
        const { port } = server.address() as { port: number }
        try {
            const submitter = new BundlerRpcSubmitter(`http://127.0.0.1:${port}`, ENTRY_POINT)
            await expect(submitter.send(operation())).rejects.toThrow(/AA24 signature error/)
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })

    it("waits for the receipt via eth_getUserOperationReceipt and parses its transaction receipt", async () => {
        const hash = `0x${"ff".repeat(32)}` as Hex

        await withFakeBundler(
            (body) => {
                if (body.method === "eth_getUserOperationReceipt") {
                    return {
                        userOpHash: hash,
                        sender: SENDER,
                        success: true,
                        actualGasCost: "0x2a",
                        actualGasUsed: "0x15",
                        receipt: {
                            transactionHash: `0x${"aa".repeat(32)}`,
                            logs: [
                                userOperationEventLog({
                                    userOpHash: hash,
                                    sender: SENDER,
                                    paymaster: PAYMASTER,
                                    nonce: 9n,
                                    success: true,
                                    actualGasCost: 42n,
                                    actualGasUsed: 21n
                                })
                            ]
                        }
                    }
                }
                throw new Error(`unexpected method ${body.method}`)
            },
            async (url) => {
                const submitter = new BundlerRpcSubmitter(url, ENTRY_POINT)
                const receipt = await submitter.waitForReceipt(hash)

                expect(receipt).toEqual({
                    transactionHash: `0x${"aa".repeat(32)}`,
                    success: true,
                    actualGasCost: 42n,
                    actualGasUsed: 21n,
                    revertReason: undefined
                })
            }
        )
    })

    it("waits for the receipt and yields success: false with the raw revertReason when the operation reverted", async () => {
        const hash = `0x${"dd".repeat(32)}` as Hex
        const revertReason = `0x${"cd".repeat(4)}` as Hex

        await withFakeBundler(
            (body) => {
                if (body.method === "eth_getUserOperationReceipt") {
                    return {
                        userOpHash: hash,
                        sender: SENDER,
                        success: false,
                        actualGasCost: "0xa",
                        actualGasUsed: "0x5",
                        receipt: {
                            transactionHash: `0x${"bb".repeat(32)}`,
                            logs: [
                                userOperationEventLog({
                                    userOpHash: hash,
                                    sender: SENDER,
                                    paymaster: PAYMASTER,
                                    nonce: 9n,
                                    success: false,
                                    actualGasCost: 10n,
                                    actualGasUsed: 5n
                                }),
                                userOperationRevertReasonLog({
                                    userOpHash: hash,
                                    sender: SENDER,
                                    nonce: 9n,
                                    revertReason
                                })
                            ]
                        }
                    }
                }
                throw new Error(`unexpected method ${body.method}`)
            },
            async (url) => {
                const submitter = new BundlerRpcSubmitter(url, ENTRY_POINT)
                const receipt = await submitter.waitForReceipt(hash)

                expect(receipt).toEqual({
                    transactionHash: `0x${"bb".repeat(32)}`,
                    success: false,
                    actualGasCost: 10n,
                    actualGasUsed: 5n,
                    revertReason
                })
            }
        )
    })
})
