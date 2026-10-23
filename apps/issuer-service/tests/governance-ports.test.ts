import assert from "node:assert/strict"
import { test } from "node:test"
import {
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    parseAbi,
    parseAbiParameters,
    parseTransaction,
    toFunctionSelector
} from "viem"
import type { Hex } from "viem"
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts"
import { Hex32 } from "@coordination-network/credential"
import {
    NETWORK_MEMBER_GOVERNANCE_ABI,
    NETWORK_MEMBER_REGISTRY_ABI,
    memberAccountKey
} from "@coordination-network/network-member-governance"
import { buildGovernancePorts } from "../src/governance-ports"
import { GovernanceConfig } from "../src/config"

const AUTH_PRIVATE_KEY = `0x${"11".repeat(32)}` as const
const GOVERNANCE_SIGNER_PRIVATE_KEY = `0x${"22".repeat(32)}` as const
const REGISTRY = `0x${"44".repeat(20)}` as const
const SAFE = `0x${"77".repeat(20)}` as const
const OWNER = `0x${"99".repeat(20)}` as const
const CANDIDATE_KEY = memberAccountKey(privateKeyToAccount(`0x${"bb".repeat(32)}`).publicKey)
const CANDIDATE_ID = CANDIDATE_KEY.memberNetworkId as Hex32
const APPROVE_TX_HASH = `0x${"aa".repeat(32)}` as const
const EXEC_TX_HASH = `0x${"cc".repeat(32)}` as const

const IS_APPROVED_SELECTOR = toFunctionSelector("function isApproved(bytes32 memberNetworkId) view returns (bool)")
const NONCE_SELECTOR = toFunctionSelector("function nonce() view returns (uint256)")
const GET_OWNERS_SELECTOR = toFunctionSelector("function getOwners() view returns (address[])")
const GET_THRESHOLD_SELECTOR = toFunctionSelector("function getThreshold() view returns (uint256)")
const APPROVED_HASHES_SELECTOR = toFunctionSelector(
    "function approvedHashes(address owner, bytes32 safeTxHash) view returns (uint256)"
)

const GOVERNANCE_SIGNER = privateKeyToAddress(GOVERNANCE_SIGNER_PRIVATE_KEY)

const boolResult = (value: boolean): Hex => `0x${"0".repeat(63)}${value ? "1" : "0"}`
const uintResult = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

/** The owner an `approvedHashes(owner, hash)` call is asking about, read back out of its calldata. */
const approvedHashesOwner = (data: Hex): string => `0x${data.slice(34, 74)}`.toLowerCase()

/** A `NetworkMemberJoinRequested` log for `CANDIDATE_ID`, encoded the way a node would return one. */
function joinRequestLog(metadataURI: string) {
    return {
        address: REGISTRY,
        topics: encodeEventTopics({
            abi: NETWORK_MEMBER_REGISTRY_ABI,
            eventName: "NetworkMemberJoinRequested",
            args: { memberNetworkId: CANDIDATE_ID }
        }) as Hex[],
        data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256, address, string"), [
            CANDIDATE_KEY.accountKeyX,
            CANDIDATE_KEY.accountKeyY,
            1n,
            OWNER,
            metadataURI
        ])
    }
}

const JOIN_REQUEST_LOG = joinRequestLog("")

/**
 * Stands in for anvil for `admitMember`'s own RPC calls: `isApproved`, the join-request log,
 * the Safe's nonce/owners/threshold/approvedHashes, then the approveHash and execTransaction sends
 * and their receipts. `approveStatus`/`execStatus` control whether each receipt reports mined
 * ("0x1") or reverted ("0x0"), so a test can assert `admitMember` throws on the reverted one
 * instead of reporting the member admitted.
 *
 * `owners` defaults to a one-owner Safe at threshold 1, where this member's own approval is the
 * whole quorum. Pass more to make it a Safe this member cannot satisfy alone.
 */
function mockAdmitMemberRpc(
    approveStatus: "0x1" | "0x0",
    execStatus: "0x1" | "0x0",
    owners: readonly `0x${string}`[] = [GOVERNANCE_SIGNER],
    sentRawTransactions: Hex[] = []
): { restore: () => void; sendCount: () => number } {
    const original = globalThis.fetch
    let sendCount = 0
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }
        let result: unknown
        switch (body.method) {
            case "eth_chainId":
                result = "0x7a69"
                break
            case "eth_getTransactionCount":
                result = "0x0"
                break
            case "eth_getBlockByNumber":
                result = {
                    number: "0x1",
                    hash: `0x${"11".repeat(32)}`,
                    baseFeePerGas: "0x3b9aca00",
                    gasLimit: "0x1000000",
                    timestamp: "0x1"
                }
                break
            case "eth_maxPriorityFeePerGas":
                result = "0x3b9aca00"
                break
            case "eth_estimateGas":
                result = "0x5208"
                break
            case "eth_getLogs":
                result = [JOIN_REQUEST_LOG]
                break
            case "eth_sendRawTransaction":
                sendCount += 1
                sentRawTransactions.push((body.params as [Hex])[0])
                result = sendCount === 1 ? APPROVE_TX_HASH : EXEC_TX_HASH
                break
            case "eth_getTransactionReceipt": {
                const [hash] = body.params as [Hex]
                result = {
                    status: hash === EXEC_TX_HASH ? execStatus : approveStatus,
                    transactionHash: hash,
                    blockHash: `0x${"11".repeat(32)}`,
                    blockNumber: "0x1",
                    logs: [],
                    logsBloom: `0x${"0".repeat(512)}`,
                    gasUsed: "0x5208",
                    cumulativeGasUsed: "0x5208",
                    transactionIndex: "0x0",
                    contractAddress: null,
                    from: OWNER,
                    to: SAFE,
                    effectiveGasPrice: "0x3b9aca00",
                    type: "0x2"
                }
                break
            }
            case "eth_call": {
                const [{ data }] = body.params as [{ data: Hex }]
                if (data.startsWith(IS_APPROVED_SELECTOR)) result = boolResult(false)
                else if (data.startsWith(NONCE_SELECTOR)) result = uintResult(0n)
                else if (data.startsWith(GET_OWNERS_SELECTOR))
                    result = encodeAbiParameters(parseAbiParameters("address[]"), [[...owners]])
                else if (data.startsWith(GET_THRESHOLD_SELECTOR)) result = uintResult(BigInt(owners.length))
                else if (data.startsWith(APPROVED_HASHES_SELECTOR)) {
                    // Only this member ever approves here, and only once its approveHash is sent.
                    const approved = sendCount > 0 && approvedHashesOwner(data) === GOVERNANCE_SIGNER.toLowerCase()
                    result = uintResult(approved ? 1n : 0n)
                } else result = "0x"
                break
            }
            default:
                result = "0x0"
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
        sendCount: () => sendCount
    }
}

/** Stands in for anvil for `pendingJoinRequests`: the logs it asks for, and `isApproved` for each. */
function mockPendingJoinRequestsRpc(logs: ReturnType<typeof joinRequestLog>[]): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }
        let result: unknown
        switch (body.method) {
            case "eth_getLogs":
                result = logs
                break
            case "eth_call":
                result = boolResult(false)
                break
            default:
                result = "0x0"
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            status: 200,
            headers: { "content-type": "application/json" }
        })
    }) as typeof fetch
    return () => {
        globalThis.fetch = original
    }
}

function fakeConfig(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
    return {
        authPrivateKey: AUTH_PRIVATE_KEY,
        governanceSignerPrivateKey: GOVERNANCE_SIGNER_PRIVATE_KEY,
        networkId: `0x${"33".repeat(32)}` as Hex32,
        semaphoreCommitment: 1n,
        metaStealthAddress: `0x${"99".repeat(66)}`,
        registry: `0x${"44".repeat(20)}`,
        group: `0x${"55".repeat(20)}`,
        governance: `0x${"66".repeat(20)}`,
        safe: `0x${"77".repeat(20)}`,
        issuerSet: `0x${"88".repeat(20)}`,
        deployBlock: 0,
        metadataURI: "",
        chainId: 31337,
        ...overrides
    }
}

test("buildGovernancePorts derives the auth and governance-signer addresses from their private keys", () => {
    const ports = buildGovernancePorts(fakeConfig(), "http://127.0.0.1:1")

    assert.equal(ports.authAddress, privateKeyToAddress(AUTH_PRIVATE_KEY))
    assert.equal(ports.governanceSigner, privateKeyToAddress(GOVERNANCE_SIGNER_PRIVATE_KEY))
    assert.equal(ports.safeAddress.toLowerCase(), `0x${"77".repeat(20)}`)
    assert.equal(ports.networkId, `0x${"33".repeat(32)}`)
    assert.equal(ports.metaStealthAddress, `0x${"99".repeat(66)}`)
})

test("buildGovernancePorts never confuses the auth key with the governance signer", () => {
    const ports = buildGovernancePorts(fakeConfig(), "http://127.0.0.1:1")

    assert.notEqual(ports.authAddress, ports.governanceSigner)
})

test("admitMember throws when the approveHash receipt reverts, instead of going on to execTransaction", async () => {
    const { restore } = mockAdmitMemberRpc("0x0", "0x1")
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        await assert.rejects(ports.admitMember(CANDIDATE_ID), /approveHash transaction 0x[0-9a-f]+ reverted/)
    } finally {
        restore()
    }
})

test("admitMember throws when the execTransaction receipt reverts, not reporting the member admitted", async () => {
    const { restore } = mockAdmitMemberRpc("0x1", "0x0")
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        await assert.rejects(ports.admitMember(CANDIDATE_ID), /execTransaction transaction 0x[0-9a-f]+ reverted/)
    } finally {
        restore()
    }
})

test("admitMember reports the approvals still missing, and sends no execTransaction, below the threshold", async () => {
    const { restore, sendCount } = mockAdmitMemberRpc("0x1", "0x1", [GOVERNANCE_SIGNER, OWNER])
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        const outcome = await ports.admitMember(CANDIDATE_ID)
        if (outcome.status !== "awaitingApprovals") throw new Error(`admitMember reported ${outcome.status}`)

        assert.equal(outcome.approvals, 1)
        assert.equal(outcome.threshold, 2)
        assert.equal(outcome.approveTxHash, APPROVE_TX_HASH)
        // Below quorum, only the approveHash send has any business going out.
        assert.equal(sendCount(), 1)
    } finally {
        restore()
    }
})

test("admitMember executes once its own approval completes the quorum, reporting both hashes", async () => {
    const { restore } = mockAdmitMemberRpc("0x1", "0x1")
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        const outcome = await ports.admitMember(CANDIDATE_ID)
        if (outcome.status !== "admitted") throw new Error(`admitMember reported ${outcome.status}`)

        assert.equal(outcome.approveTxHash, APPROVE_TX_HASH)
        assert.equal(outcome.execTxHash, EXEC_TX_HASH)
        assert.equal(outcome.approvals, 1)
        assert.equal(outcome.threshold, 1)
    } finally {
        restore()
    }
})

test("pendingJoinRequests dedupes two logs from the same candidate, keeping the latest", async () => {
    const restore = mockPendingJoinRequestsRpc([joinRequestLog("first"), joinRequestLog("second")])
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        const pending = await ports.pendingJoinRequests()
        assert.equal(pending.length, 1)
        assert.equal(pending[0].metadataURI, "second")
    } finally {
        restore()
    }
})

test("requestToJoin announces the account key of the auth private key, not the networkId", async () => {
    const sent: Hex[] = []
    const { restore } = mockAdmitMemberRpc("0x1", "0x1", [GOVERNANCE_SIGNER], sent)
    try {
        const ports = buildGovernancePorts(
            fakeConfig({ metadataURI: "https://candidate.example" }),
            "http://fake-rpc.test"
        )
        await ports.requestToJoin()

        assert.equal(sent.length, 1)
        const { data } = parseTransaction(sent[0] as `0x02${string}`)
        const { functionName, args } = decodeFunctionData({ abi: NETWORK_MEMBER_REGISTRY_ABI, data: data as Hex })
        const { accountKeyX, accountKeyY } = memberAccountKey(privateKeyToAccount(AUTH_PRIVATE_KEY).publicKey)

        assert.equal(functionName, "requestToJoin")
        assert.deepEqual(args, [accountKeyX, accountKeyY, 1n, GOVERNANCE_SIGNER, "https://candidate.example"])
    } finally {
        restore()
    }
})

test("admitMember builds the admission from the key the candidate's own log carries", async () => {
    const sent: Hex[] = []
    const { restore } = mockAdmitMemberRpc("0x1", "0x1", [GOVERNANCE_SIGNER], sent)
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        await ports.admitMember(CANDIDATE_ID)

        // The second send is the Safe's execTransaction, whose payload is the admitMember call.
        assert.equal(sent.length, 2)
        const exec = decodeFunctionData({
            abi: parseAbi([
                "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)"
            ]),
            data: parseTransaction(sent[1] as `0x02${string}`).data as Hex
        })
        const admission = decodeFunctionData({ abi: NETWORK_MEMBER_GOVERNANCE_ABI, data: exec.args[2] })

        assert.equal(admission.functionName, "admitMember")
        assert.deepEqual(admission.args?.slice(0, 2), [CANDIDATE_KEY.accountKeyX, CANDIDATE_KEY.accountKeyY])
    } finally {
        restore()
    }
})

/** An RPC that answers `eth_blockNumber` from `head()` and records each `eth_getLogs` range as hex. */
function mockLogRangesRpc(head: () => number, logsFor: (call: number) => unknown[] = () => []) {
    const original = globalThis.fetch
    const ranges: string[][] = []
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }
        let result: unknown = "0x0"
        if (body.method === "eth_blockNumber") result = `0x${head().toString(16)}`
        else if (body.method === "eth_getLogs") {
            const [{ fromBlock, toBlock }] = body.params as [{ fromBlock: string; toBlock: string }]
            ranges.push([fromBlock, toBlock])
            result = logsFor(ranges.length)
        } else if (body.method === "eth_call") result = boolResult(false)
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            status: 200,
            headers: { "content-type": "application/json" }
        })
    }) as typeof fetch
    return {
        ranges,
        restore: () => {
            globalThis.fetch = original
        }
    }
}

test("join-request reads fetch only the blocks added since the previous call", async () => {
    let head = 10
    const { ranges, restore } = mockLogRangesRpc(
        () => head,
        (call) => (call === 1 ? [JOIN_REQUEST_LOG] : [])
    )
    try {
        const ports = buildGovernancePorts(fakeConfig({ deployBlock: 4, logConfirmations: 0 }), "http://fake-rpc.test")

        assert.equal((await ports.pendingJoinRequests()).length, 1)
        head = 15
        assert.equal((await ports.pendingJoinRequests()).length, 1)

        assert.deepEqual(ranges, [
            ["0x4", "0xa"],
            ["0xb", "0xf"]
        ])
    } finally {
        restore()
    }
})

test("logConfirmations holds the join-request scan behind the head", async () => {
    const { ranges, restore } = mockLogRangesRpc(() => 10)
    try {
        const ports = buildGovernancePorts(fakeConfig({ deployBlock: 4, logConfirmations: 2 }), "http://fake-rpc.test")
        await ports.pendingJoinRequests()

        assert.deepEqual(ranges, [["0x4", "0x8"]])
    } finally {
        restore()
    }
})

test("logWindowBlocks splits the join-request scan into windows", async () => {
    const { ranges, restore } = mockLogRangesRpc(() => 10)
    try {
        const ports = buildGovernancePorts(fakeConfig({ deployBlock: 4, logWindowBlocks: 3 }), "http://fake-rpc.test")
        await ports.pendingJoinRequests()

        assert.deepEqual(ranges, [
            ["0x4", "0x6"],
            ["0x7", "0x9"],
            ["0xa", "0xa"]
        ])
    } finally {
        restore()
    }
})

test("admitMember reports noPendingRequest for a candidate whose request is not among the logs", async () => {
    const { restore } = mockAdmitMemberRpc("0x1", "0x1")
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        const outcome = await ports.admitMember(`0x${"cc".repeat(32)}` as Hex32)

        assert.equal(outcome.status, "noPendingRequest")
    } finally {
        restore()
    }
})

/** Answers every `eth_getLogs` with `logs`, over whatever RPC mock is installed. */
function answerLogsWith(logs: unknown[]): void {
    const inner = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string }
        if (body.method !== "eth_getLogs") return inner(url as string, init)
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: logs }), {
            status: 200,
            headers: { "content-type": "application/json" }
        })
    }) as typeof fetch
}

for (const logConfirmations of [undefined, 2]) {
    test(`admitMember builds against a request the join-request index has not seen yet (confirmations ${logConfirmations})`, async () => {
        const stale = mockPendingJoinRequestsRpc([])
        const ports = buildGovernancePorts(fakeConfig({ logConfirmations }), "http://fake-rpc.test")
        try {
            assert.deepEqual(await ports.pendingJoinRequests(), [])
        } finally {
            stale()
        }

        const { restore } = mockAdmitMemberRpc("0x1", "0x1")
        try {
            assert.equal((await ports.admitMember(CANDIDATE_ID)).status, "admitted")
        } finally {
            restore()
        }
    })
}

test("admitMember does not use a request the index holds but the chain no longer returns", async () => {
    const stale = mockPendingJoinRequestsRpc([JOIN_REQUEST_LOG])
    const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
    try {
        assert.equal((await ports.pendingJoinRequests()).length, 1)
    } finally {
        stale()
    }

    const { restore } = mockAdmitMemberRpc("0x1", "0x1")
    answerLogsWith([])
    try {
        assert.equal((await ports.admitMember(CANDIDATE_ID)).status, "noPendingRequest")
    } finally {
        restore()
    }
})

test("admitMember matches a candidate id spelled in upper case", async () => {
    const { restore } = mockAdmitMemberRpc("0x1", "0x1")
    try {
        const ports = buildGovernancePorts(fakeConfig(), "http://fake-rpc.test")
        const outcome = await ports.admitMember(`0x${CANDIDATE_ID.slice(2).toUpperCase()}` as Hex32)

        assert.equal(outcome.status, "admitted")
    } finally {
        restore()
    }
})
