import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Group } from "@semaphore-protocol/group"
import type { Address, PublicClient, WalletClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Chain } from "./anvil"
import { TESTBED_CHAIN } from "./config"
import type { ContractDeployment } from "./deployer"
import { mirrorMembersIntoPaymaster, reconcilePaymasterGroup, type PaymasterMirrorOptions } from "./paymaster-group"

const PAYMASTER_ADDRESS = `0x${"11".repeat(20)}` as Address
const GROUP_ADDRESS = `0x${"22".repeat(20)}` as Address
const DEPLOYER = `0x${"33".repeat(20)}` as Address
const BLOCK_SCAN_WINDOW_SIZE = 100n
const KEYED = "https://eth-sepolia.example.io/v2/SECRETKEY"
const PAYMASTER_GROUP_ID = 7n

const PAYMASTER: ContractDeployment = { abi: [], address: PAYMASTER_ADDRESS }
const GROUP: ContractDeployment = { abi: [], address: GROUP_ADDRESS }
const FAST: PaymasterMirrorOptions = { fromBlock: 100n, pollingIntervalMs: 5 }

interface FakeLog {
    block: bigint
    commitment: bigint
    /** `NetworkMemberAdded` unless it says otherwise. */
    removed?: boolean
}

interface Write {
    functionName: string
    args: readonly unknown[]
    account?: unknown
    chain?: unknown
}

/** A `Chain` stand-in: `writeContract` drives the mirror's own failure, `logs` and `head` stand in for
 *  the member group's membership history, and `paymasterLeaves` for the paymaster group's own leaves,
 *  which the removal path replays. A write that succeeds changes the leaves it names. */
function fakeChain(options: {
    writeContract: (write: Write) => Promise<`0x${string}`>
    logs?: FakeLog[]
    head?: () => bigint
    /** Runs at the top of every `getLogs` and `getBlockNumber`; throwing fails that poll. */
    onPoll?: () => void
    /** Receives every member-group `getLogs` range. */
    onGetLogs?: (range: { fromBlock?: bigint; toBlock?: bigint }) => void
    /** Receives every paymaster-group `getLogs` range. */
    onPaymasterGetLogs?: (range: { fromBlock?: bigint; toBlock?: bigint }) => void
    /** The paymaster group's leaves in index order, `0n` for a removed one. */
    paymasterLeaves?: bigint[]
    /** Commitments the approved-member group currently holds; every commitment when omitted. */
    groupMembers?: bigint[]
    /** Resolves when the receipt does; immediate when omitted. */
    receipt?: () => Promise<unknown>
    /** Receives the name of every contract read. */
    onRead?: (functionName: string) => void
}): Chain {
    const leaves = [...(options.paymasterLeaves ?? [])]
    const holds = (commitment: bigint) => commitment !== 0n && leaves.includes(commitment)
    // The paymaster group's own history, one block per change; the leaves it starts with sit in the first blocks.
    const paymasterLogs: { eventName: string; args: Record<string, bigint>; blockNumber: bigint; logIndex: number }[] =
        []
    const logPaymasterChange = (eventName: string, args: Record<string, bigint>) =>
        paymasterLogs.push({ eventName, args, blockNumber: 60n + BigInt(paymasterLogs.length), logIndex: 0 })
    leaves.forEach((commitment, index) =>
        logPaymasterChange("MemberAdded", { index: BigInt(index), identityCommitment: commitment })
    )
    // A commitment the member group holds is one whose latest log is an add.
    const memberGroupHolds = (commitment: bigint) => {
        const history = (options.logs ?? []).filter((log) => log.commitment === commitment)
        const latest = history[history.length - 1]
        return latest !== undefined && !latest.removed
    }

    return {
        chainDefinition: TESTBED_CHAIN,
        deployer: DEPLOYER,
        signer: DEPLOYER,
        rpcUrl: "http://fake-rpc.test",
        blockScanWindowSize: BLOCK_SCAN_WINDOW_SIZE,
        stop: () => {},
        publicClient: {
            readContract: async ({
                address,
                functionName,
                args
            }: {
                address: Address
                functionName: string
                args: readonly bigint[]
            }) => {
                options.onRead?.(functionName)
                if (functionName === "hasNetworkMember")
                    return options.groupMembers?.includes(args[0]) ?? memberGroupHolds(args[0])
                if (functionName === "hasMember") return args[0] === PAYMASTER_GROUP_ID && holds(args[1])
                if (functionName === "getMerkleTreeRoot") return BigInt(new Group(leaves).root)
                if (functionName === "GROUP_ID" && address === PAYMASTER_ADDRESS) return PAYMASTER_GROUP_ID
                throw new Error(`fakeChain has no readContract answer for ${functionName}`)
            },
            waitForTransactionReceipt: async () => (await options.receipt?.()) ?? ({} as unknown),
            getBlockNumber: async () => {
                options.onPoll?.()
                return options.head?.() ?? 1000n
            },
            getLogs: async (request: {
                address: Address
                event?: { name: string }
                fromBlock: bigint
                toBlock: bigint
            }) => {
                options.onPoll?.()
                if (request.address === PAYMASTER_ADDRESS) {
                    options.onPaymasterGetLogs?.(request)
                    const to = request.toBlock ?? options.head?.() ?? 1000n
                    return paymasterLogs.filter(
                        (log) =>
                            log.eventName === request.event?.name &&
                            log.blockNumber >= (request.fromBlock ?? 0n) &&
                            log.blockNumber <= to
                    )
                }
                options.onGetLogs?.(request)
                return (options.logs ?? [])
                    .filter((log) => log.block >= request.fromBlock && log.block <= request.toBlock)
                    .map((log, index) => ({
                        eventName: log.removed ? "NetworkMemberRemoved" : "NetworkMemberAdded",
                        args: { identityCommitment: log.commitment },
                        blockNumber: log.block,
                        logIndex: index
                    }))
            }
        } as unknown as PublicClient,
        walletClient: {
            writeContract: async (write: Write) => {
                const hash = await options.writeContract(write)
                const commitment = write.args[1] as bigint
                if (write.functionName === "addMember") {
                    leaves.push(commitment)
                    logPaymasterChange("MemberAdded", {
                        index: BigInt(leaves.length - 1),
                        identityCommitment: commitment
                    })
                }
                if (write.functionName === "removeMember") {
                    const index = leaves.indexOf(commitment)
                    leaves[index] = 0n
                    logPaymasterChange("MemberRemoved", { index: BigInt(index) })
                }
                return hash
            }
        } as unknown as WalletClient
    }
}

async function settle(milliseconds = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const MINED_HASH = `0x${"aa".repeat(32)}` as const

/** Starts a mirror with no callbacks, polling quickly, and stops it once the first catch-up is done. */
async function mirrorOnce(chain: Chain, options: PaymasterMirrorOptions = FAST): Promise<void> {
    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, options)
    stop()
}

test("a mirror failure from a NetworkMemberAdded log is caught and reported, not left as an unhandled rejection", async () => {
    const diagnosticMessages: string[] = []
    const failures: [bigint, unknown][] = []
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 42n }],
        writeContract: async () => {
            throw new Error("execution reverted: not group admin")
        }
    })

    const stop = await mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        (message) => diagnosticMessages.push(message),
        () => {},
        (commitment, error) => failures.push([commitment, error]),
        FAST
    )
    stop()

    assert.deepEqual(
        failures.map(([commitment]) => commitment),
        [42n]
    )
    assert.match(diagnosticMessages.join("\n"), /execution reverted: not group admin/)
})

test("a failed mirror does not stop later admissions from being mirrored", async () => {
    const added: unknown[] = []
    let sends = 0
    const chain = fakeChain({
        logs: [
            { block: 150n, commitment: 1n },
            { block: 151n, commitment: 2n }
        ],
        writeContract: async ({ args }) => {
            sends += 1
            if (sends === 1) throw new Error("nonce too low")
            added.push(args[1])
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(added, [2n])
})

test("an admission from before the mirror started is mirrored from the start block", async () => {
    const added: unknown[] = []
    const ranges: { fromBlock?: bigint; toBlock?: bigint }[] = []
    const chain = fakeChain({
        logs: [
            { block: 99n, commitment: 9n },
            { block: 120n, commitment: 5n }
        ],
        onGetLogs: (range) => ranges.push(range),
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(added, [5n])
    assert.equal(ranges[0].fromBlock, 100n)
})

test("a failed poll is reported with its keyed URL cut to the origin, and the next poll recovers", async () => {
    const added: unknown[] = []
    const diagnostics: string[] = []
    let polls = 0
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 3n }],
        onPoll: () => {
            polls += 1
            if (polls === 1) throw Object.assign(new Error(`HTTP request failed. URL: ${KEYED}`), { url: KEYED })
        },
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        (message) => diagnostics.push(message),
        undefined,
        undefined,
        FAST
    )
    await settle()
    stop()

    assert.deepEqual(added, [3n])
    assert.match(
        diagnostics.join("\n"),
        /Failed to read paymaster group membership: .*https:\/\/eth-sepolia\.example\.io/
    )
    assert.ok(!diagnostics.join("\n").includes("SECRETKEY"))
})

test("a failed mirror is reported without the keyed URL of its error", async () => {
    const diagnostics: string[] = []
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 3n }],
        writeContract: async () => {
            throw new Error(`HTTP request failed. URL: ${KEYED}`)
        }
    })

    const stop = await mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        (message) => diagnostics.push(message),
        undefined,
        undefined,
        FAST
    )
    stop()

    assert.match(diagnostics.join("\n"), /Failed to mirror commitment 3/)
    assert.ok(!diagnostics.join("\n").includes("SECRETKEY"))
})

test("an admission that lands after the first poll is mirrored by a later one", async () => {
    const added: unknown[] = []
    const logs: FakeLog[] = []
    let head = 200n
    const chain = fakeChain({
        logs,
        head: () => head,
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, FAST)
    logs.push({ block: 250n, commitment: 8n })
    head = 300n
    await settle()
    stop()

    assert.deepEqual(added, [8n])
})

test("a periodic rescan mirrors an admission the index passed over while the provider lagged", async () => {
    const added: unknown[] = []
    const logs: FakeLog[] = []
    const chain = fakeChain({
        logs,
        head: () => 300n,
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })
    const options = { ...FAST, logConfirmations: 2, rescanIntervalMs: 20 }

    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, options)
    // The first scan already marked block 250 done without seeing this log.
    logs.push({ block: 250n, commitment: 8n })
    await settle()
    stop()

    assert.deepEqual(added, [8n])
})

test("a rescan replays every log and sends nothing for a commitment already mirrored", async () => {
    const added: unknown[] = []
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 5n }],
        head: () => 300n,
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, {
        ...FAST,
        rescanIntervalMs: 20
    })
    await settle()
    stop()

    assert.deepEqual(added, [5n])
})

test("a poll lags the head by the configured confirmations", async () => {
    const ranges: { fromBlock?: bigint; toBlock?: bigint }[] = []
    const chain = fakeChain({
        head: () => 200n,
        onGetLogs: (range) => ranges.push(range),
        writeContract: async () => MINED_HASH
    })

    await mirrorOnce(chain, { ...FAST, logConfirmations: 2 })

    assert.equal(ranges[0].toBlock, 198n)
})

test("a poll asks for no more than the log window at a time", async () => {
    const ranges: { fromBlock?: bigint; toBlock?: bigint }[] = []
    const chain = fakeChain({
        head: () => 130n,
        onGetLogs: (range) => ranges.push(range),
        writeContract: async () => MINED_HASH
    })

    await mirrorOnce(chain, { ...FAST, logWindowBlocks: 20 })

    assert.deepEqual(
        ranges.map((range) => [range.fromBlock, range.toBlock]),
        [
            [100n, 119n],
            [120n, 130n]
        ]
    )
})

test("a commitment the paymaster group already holds is not added again", async () => {
    const added: unknown[] = []
    const mirrored: [bigint, string][] = []
    const diagnostics: string[] = []
    const chain = fakeChain({
        logs: [
            { block: 150n, commitment: 1n },
            { block: 151n, commitment: 2n }
        ],
        paymasterLeaves: [1n],
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        (message) => diagnostics.push(message),
        (commitment, change) => mirrored.push([commitment, change]),
        undefined,
        FAST
    )
    stop()

    assert.deepEqual(added, [2n])
    assert.deepEqual(mirrored, [[2n, "added"]])
})

test("the membership poll runs every second unless told otherwise", async () => {
    mock.timers.enable({ apis: ["setTimeout"] })
    try {
        let polls = 0
        const chain = fakeChain({ onPoll: () => (polls += 1), writeContract: async () => MINED_HASH })

        const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, {
            fromBlock: 100n
        })
        const first = polls
        mock.timers.tick(999)
        await Promise.resolve()
        const beforeSecond = polls
        mock.timers.tick(1)
        for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve))
        stop()

        assert.equal(beforeSecond, first)
        assert.ok(polls > first)
    } finally {
        mock.timers.reset()
    }
})

test("stopping the mirror ends its polling", async () => {
    let polls = 0
    const chain = fakeChain({ onPoll: () => (polls += 1), writeContract: async () => MINED_HASH })

    await mirrorOnce(chain)
    const atStop = polls
    await settle()

    assert.equal(polls, atStop)
})

test("the paymaster group id is read once and reused for every commitment", async () => {
    const reads: string[] = []
    const groupIds: unknown[] = []
    const chain = fakeChain({
        logs: [
            { block: 150n, commitment: 1n },
            { block: 151n, commitment: 2n }
        ],
        onRead: (functionName) => reads.push(functionName),
        writeContract: async ({ args }) => {
            groupIds.push(args[0])
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.equal(reads.filter((name) => name === "GROUP_ID").length, 1)
    assert.deepEqual(groupIds, [PAYMASTER_GROUP_ID, PAYMASTER_GROUP_ID])
})

test("a write is signed by the chain's signer, on the chain's own definition", async () => {
    const writes: Write[] = []
    const signer = privateKeyToAccount(generatePrivateKey())
    const base = fakeChain({
        logs: [{ block: 150n, commitment: 2n }],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce({ ...base, signer })

    assert.equal(writes[0].account, signer)
    assert.equal(writes[0].chain, base.chainDefinition)
})

test("two admissions in one poll are mirrored one after the other, never together", async () => {
    let inFlight = 0
    let overlapped = false
    const added: unknown[] = []
    const chain = fakeChain({
        logs: [
            { block: 150n, commitment: 1n },
            { block: 150n, commitment: 2n }
        ],
        writeContract: async ({ args }) => {
            inFlight += 1
            overlapped ||= inFlight > 1
            await new Promise((resolve) => setTimeout(resolve, 10))
            added.push(args[1])
            inFlight -= 1
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(added, [1n, 2n])
    assert.equal(overlapped, false)
})

test("a failed mirror is retried on the next poll and then lands", async () => {
    const added: unknown[] = []
    let sends = 0
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 4n }],
        writeContract: async ({ args }) => {
            sends += 1
            if (sends === 1) throw new Error("nonce too low")
            added.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, FAST)
    await settle()
    stop()

    assert.deepEqual(added, [4n])
    assert.equal(sends, 2)
})

test("a commitment the member group no longer holds is not added", async () => {
    const added: unknown[] = []
    const chain = fakeChain({
        logs: [
            { block: 150n, commitment: 1n },
            { block: 151n, commitment: 2n }
        ],
        groupMembers: [2n],
        writeContract: async ({ args }) => {
            added.push(args[1])
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(added, [2n])
})

test("a member removed from the governance group is removed from the paymaster group", async () => {
    const writes: Write[] = []
    const mirrored: [bigint, string][] = []
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 22n, removed: true }],
        paymasterLeaves: [11n, 22n],
        groupMembers: [11n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        undefined,
        (commitment, change) => mirrored.push([commitment, change]),
        undefined,
        FAST
    )
    stop()

    assert.deepEqual(
        writes.map(({ functionName, args }) => ({ functionName, args })),
        [{ functionName: "removeMember", args: [PAYMASTER_GROUP_ID, 22n, [11n]] }]
    )
    assert.deepEqual(mirrored, [[22n, "removed"]])
})

test("a removal of a commitment the paymaster group never held sends nothing", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 22n, removed: true }],
        paymasterLeaves: [11n],
        groupMembers: [11n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(writes, [])
})

test("mirrors a batch of membership changes in chain order", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [
            { block: 120n, commitment: 33n },
            { block: 120n, commitment: 44n },
            { block: 130n, commitment: 22n, removed: true },
            { block: 130n, commitment: 55n }
        ],
        paymasterLeaves: [11n, 22n],
        groupMembers: [11n, 33n, 44n, 55n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(
        writes.map((write) => [write.functionName, write.args[1]]),
        [
            ["addMember", 33n],
            ["addMember", 44n],
            ["removeMember", 22n],
            ["addMember", 55n]
        ]
    )
})

test("a commitment that was added and then removed is never sent to the paymaster group", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [
            { block: 120n, commitment: 6n },
            { block: 130n, commitment: 6n, removed: true }
        ],
        groupMembers: [],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(writes, [])
})

test("a failed removal is retried on the next poll and then lands", async () => {
    const removed: unknown[] = []
    let sends = 0
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 22n, removed: true }],
        paymasterLeaves: [11n, 22n],
        groupMembers: [11n],
        writeContract: async ({ args }) => {
            sends += 1
            if (sends === 1) throw new Error("replacement transaction underpriced")
            removed.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, FAST)
    await settle()
    stop()

    assert.deepEqual(removed, [22n])
})

test("the send's hash is reported before its receipt resolves", async () => {
    const diagnostics: string[] = []
    let release = () => {}
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 2n }],
        receipt: () => new Promise((resolve) => (release = () => resolve({ status: "success" }))),
        writeContract: async () => MINED_HASH
    })

    const pending = mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        (message) => diagnostics.push(message),
        undefined,
        undefined,
        FAST
    )
    await settle(30)

    assert.ok(diagnostics.some((message) => message.endsWith(`sent ${MINED_HASH}`)))
    release()
    ;(await pending)()
})

test("a send that reverts is reported as a failure", async () => {
    const failures: bigint[] = []
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 2n }],
        receipt: async () => ({ status: "reverted" }),
        writeContract: async () => MINED_HASH
    })

    const stop = await mirrorMembersIntoPaymaster(
        chain,
        PAYMASTER,
        GROUP,
        undefined,
        undefined,
        (commitment) => failures.push(commitment),
        FAST
    )
    stop()

    assert.deepEqual(failures, [2n])
})

test("reconcilePaymasterGroup adds the missing and removes the departed, and leaves other commitments alone", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [
            { block: 120n, commitment: 11n },
            { block: 121n, commitment: 22n },
            { block: 122n, commitment: 33n },
            { block: 130n, commitment: 22n, removed: true }
        ],
        // 99n was added to the paymaster group by something other than the member mirror.
        paymasterLeaves: [99n, 22n],
        groupMembers: [11n, 33n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    const changes = await reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n })

    assert.deepEqual(
        writes.map((write) => [write.functionName, write.args[1]]),
        [
            ["addMember", 11n],
            ["removeMember", 22n],
            ["addMember", 33n]
        ]
    )
    assert.deepEqual(changes, [
        { commitment: 11n, change: "added" },
        { commitment: 22n, change: "removed" },
        { commitment: 33n, change: "added" }
    ])
})

test("reconcilePaymasterGroup throws when a send fails, so genesis stops", async () => {
    const chain = fakeChain({
        logs: [{ block: 120n, commitment: 11n }],
        writeContract: async () => {
            throw new Error("insufficient funds")
        }
    })

    await assert.rejects(reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n }), /insufficient funds/)
})

test("a removal sends the Merkle siblings of the commitment's own leaf in a deeper paymaster group", async () => {
    const writes: Write[] = []
    const leaves = [11n, 22n, 33n, 44n, 55n]
    const chain = fakeChain({
        logs: [{ block: 150n, commitment: 33n, removed: true }],
        paymasterLeaves: leaves,
        groupMembers: [11n, 22n, 44n, 55n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].args, [PAYMASTER_GROUP_ID, 33n, new Group(leaves).generateMerkleProof(2).siblings])
})

test("a commitment added, removed and added again is sent once, decided on the member group's current state", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [
            { block: 120n, commitment: 6n },
            { block: 130n, commitment: 6n, removed: true },
            { block: 140n, commitment: 6n }
        ],
        groupMembers: [6n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(
        writes.map((write) => [write.functionName, write.args[1]]),
        [["addMember", 6n]]
    )
})

test("the mirror never touches a paymaster-group commitment that has no member-group log", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [{ block: 120n, commitment: 11n }],
        // 99n and 98n sit in the paymaster group, put there by something other than the member mirror.
        paymasterLeaves: [99n, 98n],
        groupMembers: [11n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain)

    assert.deepEqual(
        writes.map((write) => [write.functionName, write.args[1]]),
        [["addMember", 11n]]
    )
})

test("a failed mirror is retried ahead of the commitments that arrive after it", async () => {
    const sent: unknown[] = []
    const logs: FakeLog[] = [{ block: 150n, commitment: 2n }]
    let head = 200n
    let failing = true
    const chain = fakeChain({
        logs,
        head: () => head,
        writeContract: async ({ args }) => {
            if (failing) {
                failing = false
                throw new Error("nonce too low")
            }
            sent.push(args[1])
            return MINED_HASH
        }
    })

    const stop = await mirrorMembersIntoPaymaster(chain, PAYMASTER, GROUP, undefined, undefined, undefined, FAST)
    logs.push({ block: 250n, commitment: 3n })
    head = 300n
    await settle()
    stop()

    assert.deepEqual(sent, [2n, 3n])
})

test("a second reconcilePaymasterGroup pass sends nothing", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [
            { block: 120n, commitment: 11n },
            { block: 121n, commitment: 22n },
            { block: 130n, commitment: 22n, removed: true }
        ],
        paymasterLeaves: [22n],
        groupMembers: [11n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })
    await reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n })
    const sentBefore = writes.length

    assert.deepEqual(await reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n }), [])
    assert.equal(writes.length, sentBefore)
})

test("reconcilePaymasterGroup with no membership logs sends nothing", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [],
        paymasterLeaves: [99n],
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    assert.deepEqual(await reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n }), [])
    assert.deepEqual(writes, [])
})

test("reconcilePaymasterGroup stops at a failed removal and leaves the later commitments unsent", async () => {
    const writes: Write[] = []
    const chain = fakeChain({
        logs: [
            { block: 130n, commitment: 22n, removed: true },
            { block: 131n, commitment: 33n }
        ],
        paymasterLeaves: [11n, 22n],
        groupMembers: [11n, 33n],
        writeContract: async (write) => {
            writes.push(write)
            throw new Error("insufficient funds")
        }
    })

    await assert.rejects(reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n }), /insufficient funds/)

    assert.deepEqual(
        writes.map((write) => write.functionName),
        ["removeMember"]
    )
})

test("reconcilePaymasterGroup reports a reverted receipt as a failure naming the hash", async () => {
    const chain = fakeChain({
        logs: [{ block: 120n, commitment: 11n }],
        receipt: async () => ({ status: "reverted" }),
        writeContract: async () => MINED_HASH
    })

    await assert.rejects(
        reconcilePaymasterGroup(chain, PAYMASTER, GROUP, { fromBlock: 100n }),
        new RegExp(`reverted: ${MINED_HASH}`)
    )
})

test("removals read the paymaster group's history in windows from its own start block", async () => {
    const writes: Write[] = []
    const ranges: { fromBlock?: bigint; toBlock?: bigint }[] = []
    const chain = fakeChain({
        logs: [
            { block: 130n, commitment: 22n, removed: true },
            { block: 131n, commitment: 33n, removed: true }
        ],
        paymasterLeaves: [11n, 22n, 33n],
        onPaymasterGetLogs: (range) => ranges.push(range),
        writeContract: async (write) => {
            writes.push(write)
            return MINED_HASH
        }
    })

    await mirrorOnce(chain, {
        fromBlock: 100n,
        paymasterGroupFromBlock: 50n,
        logWindowBlocks: 20,
        pollingIntervalMs: 5
    })

    assert.deepEqual(
        writes.map((write) => [write.functionName, write.args[1]]),
        [
            ["removeMember", 22n],
            ["removeMember", 33n]
        ]
    )
    assert.deepEqual(writes[0].args[2], new Group([11n, 22n, 33n]).generateMerkleProof(1).siblings)
    assert.deepEqual(writes[1].args[2], new Group([11n, 0n, 33n]).generateMerkleProof(2).siblings)
    assert.equal(ranges[0].fromBlock, 50n)
    assert.ok(ranges.every(({ fromBlock = 0n, toBlock = 0n }) => toBlock - fromBlock + 1n <= 20n))
})
