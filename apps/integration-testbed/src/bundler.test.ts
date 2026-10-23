import assert from "node:assert/strict"
import { test } from "node:test"
import { numberToHex, type Address, type Hex, type RpcTransactionReceipt, type SignedAuthorization } from "viem"
import { formatUserOperationRequest } from "viem/account-abstraction"
import type {
    SponsoredUserOperation,
    UserOperationReceipt,
    UserOperationSubmitter
} from "@coordination-network/network-member-client"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Chain } from "./anvil"
import { startBundler, startBundlerRpc, type Bundler } from "./bundler"
import { TESTBED_CHAIN } from "./config"

const ENTRY_POINT = `0x${"44".repeat(20)}` as Address
const SENDER = `0x${"55".repeat(20)}` as Address
const PAYMASTER = `0x${"66".repeat(20)}` as Address
const BUNDLER_ADDRESS = `0x${"99".repeat(20)}` as Address
const CHAIN_ID = 31338

const AUTHORIZATION: SignedAuthorization = {
    address: `0x${"77".repeat(20)}` as Address,
    chainId: CHAIN_ID,
    nonce: 3,
    r: `0x${"01".repeat(32)}` as Hex,
    s: `0x${"02".repeat(32)}` as Hex,
    yParity: 1
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

/** A promise this test can resolve from outside, to control exactly when a receipt lands. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    const box: { resolve?: (value: T) => void } = {}
    const promise = new Promise<T>((resolve) => {
        box.resolve = resolve
    })
    return { promise, resolve: (value: T) => box.resolve?.(value) }
}

function fakeSubmitter(): UserOperationSubmitter & {
    sent: SponsoredUserOperation[]
    receipts: Map<Hex, ReturnType<typeof deferred<UserOperationReceipt>>>
} {
    const sent: SponsoredUserOperation[] = []
    const receipts = new Map<Hex, ReturnType<typeof deferred<UserOperationReceipt>>>()
    let nextHash = 0

    return {
        sent,
        receipts,
        async send(op) {
            sent.push(op)
            const hash = `0x${String(nextHash++).padStart(64, "0")}` as Hex
            receipts.set(hash, deferred())
            return hash
        },
        async waitForReceipt(userOpHash) {
            const entry = receipts.get(userOpHash)
            if (!entry) throw new Error(`no receipt stubbed for ${userOpHash}`)
            return entry.promise
        }
    }
}

interface JsonRpcResult {
    result?: unknown
    error?: { code: number; message: string }
}

async function call(bundler: Bundler, method: string, params: unknown[] = []): Promise<JsonRpcResult> {
    const response = await fetch(bundler.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    })
    return (await response.json()) as JsonRpcResult
}

async function withBundler(
    submitter: UserOperationSubmitter,
    run: (bundler: Bundler) => Promise<void>,
    getTransactionReceipt: (hash: Hex) => Promise<RpcTransactionReceipt | null> = async () => null
): Promise<void> {
    const bundler = await startBundlerRpc({
        submitter,
        address: BUNDLER_ADDRESS,
        entryPoint: ENTRY_POINT,
        paymaster: PAYMASTER,
        chainId: CHAIN_ID,
        getTransactionReceipt,
        host: "127.0.0.1",
        port: 0
    })
    try {
        await run(bundler)
    } finally {
        await bundler.close()
    }
}

test("the bundler's url names the host it bound, and a wildcard bind reports loopback", async () => {
    const start = (host: string) =>
        startBundlerRpc({
            submitter: fakeSubmitter(),
            address: BUNDLER_ADDRESS,
            entryPoint: ENTRY_POINT,
            paymaster: PAYMASTER,
            chainId: CHAIN_ID,
            getTransactionReceipt: async () => null,
            host,
            port: 0
        })

    const loopback = await start("127.0.0.1")
    const wildcard = await start("0.0.0.0")
    const named = await start("localhost")
    try {
        assert.match(named.url, /^http:\/\/localhost:\d+$/)
        assert.match(loopback.url, /^http:\/\/127\.0\.0\.1:\d+$/)
        assert.match(wildcard.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    } finally {
        await loopback.close()
        await wildcard.close()
        await named.close()
    }
})

test("a bundler given its own account does not fund a fresh key, and one without funds a fresh key", async () => {
    const funded: unknown[] = []
    const chain = {
        chainDefinition: TESTBED_CHAIN,
        signer: privateKeyToAccount(generatePrivateKey()),
        rpcUrl: "http://127.0.0.1:1",
        walletClient: { sendTransaction: async (transaction: unknown) => void funded.push(transaction) }
    } as unknown as Chain
    const account = privateKeyToAccount(generatePrivateKey())
    const options = { chain, entryPoint: ENTRY_POINT, paymaster: PAYMASTER, host: "127.0.0.1", port: 0 }

    const supplied = await startBundler({ ...options, account })
    const sentForSupplied = funded.length
    const generated = await startBundler(options)
    try {
        assert.equal(supplied.address, account.address)
        assert.equal(sentForSupplied, 0)
        assert.equal(funded.length, 1)
        assert.notEqual(generated.address, account.address)
    } finally {
        await supplied.close()
        await generated.close()
    }
})

test("eth_chainId and eth_supportedEntryPoints answer without touching the submitter", async () => {
    const submitter = fakeSubmitter()
    await withBundler(submitter, async (bundler) => {
        assert.equal((await call(bundler, "eth_chainId")).result, numberToHex(CHAIN_ID))
        assert.deepEqual((await call(bundler, "eth_supportedEntryPoints")).result, [ENTRY_POINT])
    })
    assert.equal(submitter.sent.length, 0)
})

test("an unknown method returns a JSON-RPC -32601 error", async () => {
    await withBundler(fakeSubmitter(), async (bundler) => {
        const response = await call(bundler, "eth_estimateUserOperationGas")
        assert.equal(response.error?.code, -32601)
        assert.match(response.error?.message ?? "", /eth_estimateUserOperationGas/)
    })
})

test("a method name matching an inherited Object.prototype property still answers -32601, not that property's own value", async () => {
    await withBundler(fakeSubmitter(), async (bundler) => {
        const response = await call(bundler, "toString")
        assert.equal(response.error?.code, -32601)
    })
})

test("a malformed JSON body returns a JSON-RPC error instead of hanging or crashing", async () => {
    await withBundler(fakeSubmitter(), async (bundler) => {
        const response = await fetch(bundler.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json"
        })
        const body = (await response.json()) as JsonRpcResult
        assert.equal(body.error?.code, -32000)
        assert.match(body.error?.message ?? "", /malformed JSON-RPC request/)
    })
})

test("a JSON-RPC batch (a bare array) gets one error response rather than a hang, since batching is not supported", async () => {
    await withBundler(fakeSubmitter(), async (bundler) => {
        const response = await fetch(bundler.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify([
                { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
                { jsonrpc: "2.0", id: 2, method: "eth_chainId" }
            ])
        })
        const body = (await response.json()) as JsonRpcResult
        assert.equal(body.error?.code, -32601)
        assert.match(body.error?.message ?? "", /unknown method/)
    })
})

test("eth_sendUserOperation converts eip7702Auth back into the operation's authorization", async () => {
    const submitter = fakeSubmitter()
    const op = operation()

    await withBundler(submitter, async (bundler) => {
        const response = await call(bundler, "eth_sendUserOperation", [formatUserOperationRequest(op), ENTRY_POINT])
        assert.equal(typeof response.result, "string")
        assert.equal(submitter.sent.length, 1)
        assert.deepEqual(submitter.sent[0], op)
    })
})

test("two concurrent eth_sendUserOperation calls each get their own distinct userOpHash", async () => {
    const submitter = fakeSubmitter()

    await withBundler(submitter, async (bundler) => {
        const [responseA, responseB] = await Promise.all([
            call(bundler, "eth_sendUserOperation", [formatUserOperationRequest(operation()), ENTRY_POINT]),
            call(bundler, "eth_sendUserOperation", [formatUserOperationRequest(operation()), ENTRY_POINT])
        ])
        assert.equal(submitter.sent.length, 2)
        assert.notEqual(responseA.result, responseB.result)
    })
})

test("eth_sendUserOperation without eip7702Auth surfaces a JSON-RPC error naming the missing field", async () => {
    const submitter = fakeSubmitter()
    const formatted = formatUserOperationRequest(operation()) as Record<string, unknown>
    delete formatted.eip7702Auth

    await withBundler(submitter, async (bundler) => {
        const response = await call(bundler, "eth_sendUserOperation", [formatted, ENTRY_POINT])
        assert.equal(response.error?.code, -32000)
        assert.match(response.error?.message ?? "", /eip7702Auth/)
    })
    assert.equal(submitter.sent.length, 0)
})

test("a reverted handleOps surfaces the submitter's error as a JSON-RPC error", async () => {
    const submitter = fakeSubmitter()
    submitter.send = async () => {
        throw new Error('execution reverted: FailedOp(0, "AA24 signature error")')
    }

    await withBundler(submitter, async (bundler) => {
        const response = await call(bundler, "eth_sendUserOperation", [
            formatUserOperationRequest(operation()),
            ENTRY_POINT
        ])
        assert.equal(response.error?.code, -32000)
        assert.match(response.error?.message ?? "", /AA24 signature error/)
    })
})

test("eth_getUserOperationReceipt returns null until mined, then the raw transaction receipt", async () => {
    const submitter = fakeSubmitter()
    const rawReceipt = { transactionHash: `0x${"aa".repeat(32)}`, logs: [] } as unknown as RpcTransactionReceipt

    await withBundler(
        submitter,
        async (bundler) => {
            const sendResponse = await call(bundler, "eth_sendUserOperation", [
                formatUserOperationRequest(operation()),
                ENTRY_POINT
            ])
            const userOpHash = sendResponse.result as Hex

            assert.equal((await call(bundler, "eth_getUserOperationReceipt", [userOpHash])).result, null)

            const receipt = submitter.receipts.get(userOpHash)
            assert.ok(receipt, "the fake submitter should have stubbed a receipt for the sent operation")
            receipt.resolve({
                transactionHash: rawReceipt.transactionHash as Hex,
                success: true,
                actualGasCost: 42n,
                actualGasUsed: 21n
            })
            await new Promise((resolve) => setImmediate(resolve))

            const mined = await call(bundler, "eth_getUserOperationReceipt", [userOpHash])
            assert.deepEqual(mined.result, { userOpHash, sender: SENDER, receipt: rawReceipt })
        },
        async () => rawReceipt
    )
})

test("eth_getUserOperationReceipt answers a JSON-RPC error once waitForReceipt rejects, instead of staying null until the caller's own timeout", async () => {
    const submitter = fakeSubmitter()
    submitter.waitForReceipt = async () => {
        throw new Error("bundler never saw a transaction for this operation")
    }

    await withBundler(submitter, async (bundler) => {
        const sendResponse = await call(bundler, "eth_sendUserOperation", [
            formatUserOperationRequest(operation()),
            ENTRY_POINT
        ])
        const userOpHash = sendResponse.result as Hex

        // sendUserOperation's own .catch() on waitForReceipt runs after this call returns.
        await new Promise((resolve) => setImmediate(resolve))

        const response = await call(bundler, "eth_getUserOperationReceipt", [userOpHash])
        assert.equal(response.error?.code, -32000)
        assert.match(response.error?.message ?? "", /bundler never saw a transaction/)
    })
})

test("an operation naming another paymaster is rejected before anything is sent", async () => {
    const submitter = fakeSubmitter()

    await withBundler(submitter, async (bundler) => {
        const response = await call(bundler, "eth_sendUserOperation", [
            formatUserOperationRequest(operation({ paymaster: `0x${"99".repeat(20)}` as Address })),
            ENTRY_POINT
        ])

        assert.match(response.error?.message ?? "", /not the one this bundler serves/)
        assert.deepEqual(submitter.sent, [])
    })
})

test("the bundler's error answers carry no provider URL", async () => {
    const keyed = "https://eth-sepolia.example.io/v2/SECRETKEY"
    const submitter = fakeSubmitter()
    submitter.waitForReceipt = async () => {
        throw new Error(`HTTP request failed.\n\nURL: ${keyed}`)
    }

    await withBundler(submitter, async (bundler) => {
        const sendResponse = await call(bundler, "eth_sendUserOperation", [
            formatUserOperationRequest(operation()),
            ENTRY_POINT
        ])
        await new Promise((resolve) => setImmediate(resolve))

        const response = await call(bundler, "eth_getUserOperationReceipt", [sendResponse.result as Hex])
        assert.ok(response.error?.message)
        assert.ok(!JSON.stringify(response).includes("SECRETKEY"))
    })
})

test("eth_getUserOperationReceipt still returns the raw transaction receipt for an operation that reverted", async () => {
    const submitter = fakeSubmitter()
    const rawReceipt = { transactionHash: `0x${"bb".repeat(32)}`, logs: [] } as unknown as RpcTransactionReceipt

    await withBundler(
        submitter,
        async (bundler) => {
            const sendResponse = await call(bundler, "eth_sendUserOperation", [
                formatUserOperationRequest(operation()),
                ENTRY_POINT
            ])
            const userOpHash = sendResponse.result as Hex

            const receipt = submitter.receipts.get(userOpHash)
            assert.ok(receipt, "the fake submitter should have stubbed a receipt for the sent operation")
            receipt.resolve({
                transactionHash: rawReceipt.transactionHash as Hex,
                success: false,
                actualGasCost: 42n,
                actualGasUsed: 21n,
                revertReason: "0xdeadbeef"
            })
            await new Promise((resolve) => setImmediate(resolve))

            const mined = await call(bundler, "eth_getUserOperationReceipt", [userOpHash])
            assert.deepEqual(mined.result, { userOpHash, sender: SENDER, receipt: rawReceipt })
        },
        async () => rawReceipt
    )
})
