import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
    createPublicClient,
    createWalletClient,
    hexToNumber,
    isAddressEqual,
    http,
    nonceManager,
    numberToHex,
    parseEther,
    type Address,
    type Hex,
    type LocalAccount,
    type RpcAuthorization,
    type RpcTransactionReceipt,
    type SignedAuthorization
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { formatUserOperation, type RpcUserOperation, type UserOperation } from "viem/account-abstraction"
import {
    EntryPointSubmitter,
    type SponsoredUserOperation,
    type UserOperationReceipt,
    type UserOperationSubmitter
} from "@coordination-network/network-member-client"
import { Chain } from "./anvil"
import { redactUrls } from "./redact-urls"

const MAX_TRACKED_OPERATIONS = 50
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_EXECUTION_ERROR = -32000

interface JsonRpcRequestBody {
    jsonrpc: "2.0"
    id: number | string | null
    method: string
    params?: unknown[]
}

/** One tracked user operation's outcome, as read back by `recent()`. */
export interface BundlerOperationSummary {
    userOpHash: Hex
    sender: Address
    /** `null` until `eth_getUserOperationReceipt` has something to report. */
    success: boolean | null
}

interface TrackedOperation {
    sender: Address
    transactionHash?: Hex
    receipt: UserOperationReceipt | null
    /** Set when `waitForReceipt` itself rejected, so `eth_getUserOperationReceipt` can answer an
     *  error instead of `null` forever. */
    failure?: string
}

export interface Bundler {
    url: string
    address: Address
    close(): Promise<void>
    recent(limit?: number): BundlerOperationSummary[]
}

/** The EIP-7702 authorization `BundlerRpcSubmitter` sends as `eip7702Auth`; `formatUserOperation`
 *  converts the bigint fields of a user operation but leaves this one untouched. */
function toSignedAuthorization(authorization: RpcAuthorization): SignedAuthorization {
    return {
        address: authorization.address,
        chainId: hexToNumber(authorization.chainId),
        nonce: hexToNumber(authorization.nonce),
        r: authorization.r,
        s: authorization.s,
        yParity: hexToNumber(authorization.yParity)
    }
}

function requireField<T>(value: T | undefined, field: string): T {
    if (value === undefined) throw new Error(`user operation is missing ${field}`)
    return value
}

/**
 * Parses the RPC-shaped operation `BundlerRpcSubmitter` sends. `formatUserOperation` handles the
 * bigint gas and nonce fields; the paymaster fields and `eip7702Auth` are optional in viem's own
 * type (a user operation need not have either) but always present for this stack's only kind.
 */
export function parseSponsoredUserOperation(rpcOperation: RpcUserOperation): SponsoredUserOperation {
    const operation = formatUserOperation(rpcOperation) as UserOperation<"0.8">
    return {
        sender: operation.sender,
        nonce: operation.nonce,
        factory: "0x7702",
        callData: operation.callData,
        callGasLimit: operation.callGasLimit,
        verificationGasLimit: operation.verificationGasLimit,
        preVerificationGas: operation.preVerificationGas,
        maxFeePerGas: operation.maxFeePerGas,
        maxPriorityFeePerGas: operation.maxPriorityFeePerGas,
        paymaster: requireField(operation.paymaster, "paymaster"),
        paymasterVerificationGasLimit: requireField(
            operation.paymasterVerificationGasLimit,
            "paymasterVerificationGasLimit"
        ),
        paymasterPostOpGasLimit: requireField(operation.paymasterPostOpGasLimit, "paymasterPostOpGasLimit"),
        paymasterData: requireField(operation.paymasterData, "paymasterData"),
        authorization: toSignedAuthorization(requireField(rpcOperation.eip7702Auth, "eip7702Auth")),
        signature: operation.signature
    }
}

function readJsonBody(request: IncomingMessage): Promise<JsonRpcRequestBody> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequestBody)
            } catch (error) {
                reject(error)
            }
        })
        request.once("error", reject)
    })
}

function sendJsonRpc(response: ServerResponse, id: JsonRpcRequestBody["id"], result: unknown): void {
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.end(
        JSON.stringify({ jsonrpc: "2.0", id, result }, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value
        )
    )
}

function sendJsonRpcError(response: ServerResponse, id: JsonRpcRequestBody["id"], code: number, message: string): void {
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
}

export interface BundlerRpcOptions {
    submitter: UserOperationSubmitter
    /** This bundler's own account, exposed for the dashboard's balance and nonce reads. */
    address: Address
    entryPoint: Address
    /** The only paymaster whose operations this bundler will pay `handleOps` for. */
    paymaster: Address
    chainId: number
    /** Raw `eth_getTransactionReceipt`, so `eth_getUserOperationReceipt`'s `receipt` field is the
     *  real RPC-shaped transaction receipt `BundlerRpcSubmitter`'s own formatter expects. */
    getTransactionReceipt(hash: Hex): Promise<RpcTransactionReceipt | null>
    host?: string
    port?: number
    /** Appended to the dashboard's activity ring, when the stack wires one up. */
    onActivity?: (message: string) => void
}

/**
 * The JSON-RPC layer alone, against an already-built {@link UserOperationSubmitter}: no mempool,
 * one `handleOps` per `eth_sendUserOperation`. Exported separately from {@link startBundler} so it
 * can run against a fake submitter without a chain.
 */
export async function startBundlerRpc({
    submitter,
    address,
    entryPoint,
    paymaster,
    chainId,
    getTransactionReceipt,
    host = "0.0.0.0",
    port = 4337,
    onActivity = () => {}
}: BundlerRpcOptions): Promise<Bundler> {
    const operations = new Map<Hex, TrackedOperation>()

    async function sendUserOperation(params: unknown[] | undefined): Promise<Hex> {
        const [rpcOperation] = (params ?? []) as [RpcUserOperation]
        const operation = parseSponsoredUserOperation(rpcOperation)
        // The bundler pays for `handleOps` and is repaid by the paymaster named in the operation, so a
        // paymaster of the caller's choosing would let a peer drain the bundler's key.
        if (!isAddressEqual(operation.paymaster, paymaster)) {
            throw new Error(`paymaster ${operation.paymaster} is not the one this bundler serves`)
        }
        const userOpHash = await submitter.send(operation)

        operations.set(userOpHash, { sender: operation.sender, receipt: null })
        if (operations.size > MAX_TRACKED_OPERATIONS) {
            const oldest = operations.keys().next().value
            if (oldest !== undefined) operations.delete(oldest)
        }
        onActivity(`sent user operation ${userOpHash} from ${operation.sender}`)

        submitter
            .waitForReceipt(userOpHash)
            .then((receipt) => {
                const tracked = operations.get(userOpHash)
                if (tracked) {
                    tracked.transactionHash = receipt.transactionHash
                    tracked.receipt = receipt
                }
                onActivity(`user operation ${userOpHash} mined; success=${receipt.success}`)
            })
            .catch((error: unknown) => {
                const message = redactUrls(error instanceof Error ? error.message : String(error))
                const tracked = operations.get(userOpHash)
                if (tracked) tracked.failure = message
                onActivity(`user operation ${userOpHash} never got a receipt: ${message}`)
            })

        return userOpHash
    }

    async function getUserOperationReceipt(params: unknown[] | undefined): Promise<unknown> {
        const [userOpHash] = (params ?? []) as [Hex]
        const tracked = operations.get(userOpHash)
        // Answers as a JSON-RPC error (via the dispatcher's own catch), not null, so
        // BundlerRpcSubmitter.waitForReceipt fails fast instead of polling to its own timeout.
        if (tracked?.failure !== undefined) throw new Error(tracked.failure)
        if (!tracked?.receipt || !tracked.transactionHash) return null

        return { userOpHash, sender: tracked.sender, receipt: await getTransactionReceipt(tracked.transactionHash) }
    }

    const handlers: Record<string, (params: unknown[] | undefined) => Promise<unknown>> = {
        eth_chainId: async () => numberToHex(chainId),
        eth_supportedEntryPoints: async () => [entryPoint],
        eth_sendUserOperation: sendUserOperation,
        eth_getUserOperationReceipt: getUserOperationReceipt
    }

    const server = createServer((request, response) => {
        readJsonBody(request)
            .then(async (body) => {
                // Not Object.hasOwn: this repo's target predates ES2022. hasOwnProperty.call is
                // the same check without it, so a method name like "constructor" or "toString"
                // still answers -32601 instead of resolving an inherited Object.prototype member.
                if (!Object.prototype.hasOwnProperty.call(handlers, body.method)) {
                    sendJsonRpcError(response, body.id, JSON_RPC_METHOD_NOT_FOUND, `unknown method ${body.method}`)
                    return
                }
                const handler = handlers[body.method]
                try {
                    sendJsonRpc(response, body.id, await handler(body.params))
                } catch (error) {
                    sendJsonRpcError(
                        response,
                        body.id,
                        JSON_RPC_EXECUTION_ERROR,
                        redactUrls(error instanceof Error ? error.message : String(error))
                    )
                }
            })
            .catch(() => sendJsonRpcError(response, null, JSON_RPC_EXECUTION_ERROR, "malformed JSON-RPC request"))
    })

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
    })
    const bound = server.address()
    if (!bound || typeof bound === "string") throw new Error("bundler server did not bind to a port")

    return {
        // A wildcard bind is reached through loopback; any other host is the one callers must use.
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${bound.port}`,
        address,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
        recent(limit = MAX_TRACKED_OPERATIONS) {
            return [...operations.entries()]
                .slice(-limit)
                .reverse()
                .map(([userOpHash, tracked]) => ({
                    userOpHash,
                    sender: tracked.sender,
                    success: tracked.receipt ? tracked.receipt.success : null
                }))
        }
    }
}

export interface StartBundlerOptions {
    chain: Chain
    entryPoint: Address
    paymaster: Address
    /** Signs and pays for the `handleOps` sends. Without one the bundler generates its own key and
     *  funds it from the chain's signer, which only a local chain can afford. */
    account?: LocalAccount
    host?: string
    port?: number
    onActivity?: (message: string) => void
}

/** A fresh key, so the bundler's balance and nonce read apart from the deployer's. */
async function fundedBundlerAccount(chain: Chain): Promise<LocalAccount> {
    // Two member servers can relay a registration through this bundler at once; without a nonce
    // manager both `handleOps` sends would read the same pending nonce and one fails spuriously.
    const account = privateKeyToAccount(generatePrivateKey(), { nonceManager })
    await chain.walletClient.sendTransaction({
        account: chain.signer,
        chain: chain.chainDefinition,
        to: account.address,
        value: parseEther("100")
    })
    return account
}

/** The stack's own bundler, submitting straight to the EntryPoint. */
export async function startBundler({
    chain,
    entryPoint,
    paymaster,
    account: suppliedAccount,
    host,
    port,
    onActivity
}: StartBundlerOptions): Promise<Bundler> {
    const account = suppliedAccount ?? (await fundedBundlerAccount(chain))

    const walletClient = createWalletClient({ account, chain: chain.chainDefinition, transport: http(chain.rpcUrl) })
    const publicClient = createPublicClient({ chain: chain.chainDefinition, transport: http(chain.rpcUrl) })
    const submitter = new EntryPointSubmitter(
        {
            account: walletClient.account,
            chain: walletClient.chain,
            sendTransaction: walletClient.sendTransaction,
            waitForTransactionReceipt: publicClient.waitForTransactionReceipt
        },
        entryPoint
    )

    return startBundlerRpc({
        submitter,
        address: account.address,
        entryPoint,
        paymaster,
        chainId: chain.chainDefinition.id,
        getTransactionReceipt: (hash) => publicClient.request({ method: "eth_getTransactionReceipt", params: [hash] }),
        host,
        port,
        onActivity
    })
}
