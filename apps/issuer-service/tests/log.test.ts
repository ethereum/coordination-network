import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import { BaseError, ContractFunctionExecutionError, WaitForTransactionReceiptTimeoutError, parseAbi } from "viem"
import type * as Viem from "viem"
import { describeError } from "../src/log"

const NETWORK_ID = `0x${"aa".repeat(32)}`
const META_STEALTH_ADDRESS = `0x${"bb".repeat(53)}`
const CONTRACT_ADDRESS = `0x${"cc".repeat(20)}` as `0x${string}`

// The copy network-member-client's dist resolves, not this app's.
const clientViem = createRequire(require.resolve("@coordination-network/network-member-client"))("viem") as typeof Viem

function viemError() {
    return new ContractFunctionExecutionError(new BaseError("rpc timed out"), {
        abi: parseAbi(["function registerIdentity(bytes32 networkId, bytes metaStealthAddress)"]),
        args: [NETWORK_ID, META_STEALTH_ADDRESS],
        functionName: "registerIdentity",
        contractAddress: CONTRACT_ADDRESS
    })
}

test("returns only the short message for a viem error, whose full message carries the call args", () => {
    const error = viemError()

    assert.ok(error.message.includes(NETWORK_ID))
    assert.equal(describeError(error), "ContractFunctionExecutionError: rpc timed out")
})

test("keeps a viem error's stack frames but not the message its stack header repeats", () => {
    const described = describeError(viemError(), { stack: true })

    assert.ok(described.startsWith("ContractFunctionExecutionError: rpc timed out\n    at "))
    assert.equal(described.includes("Contract Call"), false)
})

test("returns only the short message for an error from network-member-client's viem copy", () => {
    const error = new clientViem.HttpRequestError({ url: "https://rpc.example/key", body: { params: [NETWORK_ID] } })

    assert.equal(error instanceof BaseError, false)
    assert.equal(describeError(error), "HttpRequestError: HTTP request failed.")
})

test("masks a transaction hash in viem's receipt-timeout short message", () => {
    const hash = `0x${"dd".repeat(32)}` as `0x${string}`
    const error = new WaitForTransactionReceiptTimeoutError({ hash })

    assert.ok(error.shortMessage.includes(hash))
    assert.equal(describeError(error).includes(hash), false)
})

test("masks a userOp hash in a plain Error's message and stack", () => {
    const hash = `0x${"ee".repeat(32)}`
    const error = new Error(`no transaction sent for user operation ${hash}`)

    assert.equal(describeError(error).includes(hash), false)
    assert.equal(describeError(error, { stack: true }).includes(hash), false)
})

test("masks the whole of a hex string longer than 32 bytes, not just its first 32", () => {
    const calldata = `0x12345678${"aa".repeat(32)}`

    assert.equal(describeError(new Error(`reverted with ${calldata}`)), "Error: reverted with 0x<redacted>")
})

test("returns name: message for a plain Error", () => {
    const error = new Error("connection reset")

    assert.equal(describeError(error), "Error: connection reset")
})

test("returns the stack for a plain Error when stack is requested", () => {
    const error = new Error("connection reset")

    assert.equal(describeError(error, { stack: true }), error.stack)
})

test("returns just the type for a non-Error cause", () => {
    assert.equal(describeError("0xdeadbeef"), "string")
})
