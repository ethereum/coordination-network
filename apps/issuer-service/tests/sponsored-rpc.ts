import { toFunctionSelector } from "viem"
import type { Address, Hex } from "viem"
import type { SponsoredConfig } from "../src/config"

export const RPC_URL = "http://fake-rpc.test"
export const BUNDLER_URL = "http://fake-bundler.test/key-abc123"
export const CHAIN_ID = 31337
export const ENTRY_POINT = `0x${"44".repeat(20)}` as Address
export const PAYMASTER = `0x${"55".repeat(20)}` as Address
export const ACCOUNT_IMPLEMENTATION = `0x${"66".repeat(20)}` as Address

export const SPONSORED: SponsoredConfig = {
    memberSecret: `0x${"44".repeat(32)}`,
    entryPoint: ENTRY_POINT,
    paymaster: PAYMASTER,
    accountImplementation: ACCOUNT_IMPLEMENTATION,
    bundlerUrl: BUNDLER_URL,
    paymasterGroupFromBlock: 0
}

const GROUP_ID_SELECTOR = toFunctionSelector("function GROUP_ID() view returns (uint256)")

export const uintResult = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`
export const addressResult = (address: Address): Hex => `0x${address.slice(2).padStart(64, "0")}`

export interface Call {
    to: Address
    data: Hex
}

export interface SponsoredRpcOptions {
    /** Addresses with no contract code; every other address has some. */
    noCodeAt?: Address[]
    bundlerChainId?: number
    bundlerEntryPoints?: Address[]
    /** What `eth_blockNumber` answers; the default is block 0. */
    blockNumber?: bigint
    /** Answers every `eth_call` that is not the paymaster's `GROUP_ID`. */
    onCall?: (call: Call) => Hex
}

/**
 * Stands in for both the chain RPC and the bundler by routing on the request URL. Records every
 * JSON-RPC method seen per endpoint, so a test can assert what was (not) sent.
 */
export function mockSponsoredRpc(options: SponsoredRpcOptions = {}): {
    restore: () => void
    rpcMethods: string[]
    bundlerMethods: string[]
    /** The `from-to` block range of every `eth_getLogs`, in request order. */
    logRanges: string[]
} {
    const {
        noCodeAt = [],
        bundlerChainId = CHAIN_ID,
        bundlerEntryPoints = [ENTRY_POINT],
        blockNumber = 0n,
        onCall
    } = options
    const rpcMethods: string[] = []
    const logRanges: string[] = []
    const bundlerMethods: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
        let result: unknown
        if (String(url) === BUNDLER_URL) {
            bundlerMethods.push(body.method)
            result = body.method === "eth_chainId" ? `0x${bundlerChainId.toString(16)}` : bundlerEntryPoints
        } else {
            rpcMethods.push(body.method)
            switch (body.method) {
                case "eth_chainId":
                    result = `0x${CHAIN_ID.toString(16)}`
                    break
                case "eth_getCode": {
                    const [address] = body.params as [Address]
                    result = noCodeAt.some((a) => a.toLowerCase() === address.toLowerCase()) ? "0x" : "0x6001"
                    break
                }
                case "eth_call": {
                    const [call] = body.params as [Call]
                    result = call.data.startsWith(GROUP_ID_SELECTOR) ? uintResult(9n) : (onCall?.(call) ?? "0x")
                    break
                }
                case "eth_blockNumber":
                    result = `0x${blockNumber.toString(16)}`
                    break
                case "eth_getLogs": {
                    const [filter] = body.params as [{ fromBlock: Hex; toBlock: Hex }]
                    logRanges.push(`${BigInt(filter.fromBlock)}-${BigInt(filter.toBlock)}`)
                    result = []
                    break
                }
                default:
                    result = "0x0"
            }
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            status: 200,
            headers: { "content-type": "application/json" }
        })
    }) as typeof fetch
    return {
        restore: () => {
            globalThis.fetch = original
        },
        rpcMethods,
        bundlerMethods,
        logRanges
    }
}
