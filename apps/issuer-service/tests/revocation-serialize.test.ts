import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex } from "viem"
import { NetworkMemberProof } from "@coordination-network/network-member-proof"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { createSerializedRevoke, RevokeChainOps } from "../src/revocation"

/** Stands in for a real membership proof: nothing here verifies one, only that the same object
 *  reaches every attempt. */
const proofFor = (commitment: bigint): NetworkMemberProof => ({
    merkleTreeDepth: 1n,
    merkleTreeRoot: 2n,
    nullifier: commitment,
    scope: 4n,
    points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]
})

const proveRevocation = async (commitment: bigint): Promise<NetworkMemberProof> => proofFor(commitment)

const unreachableRebuild = async (): Promise<RevocationRegistry> => {
    throw new Error("should not be reached: no failure occurs in this case")
}

test("a reverted receipt re-syncs (a no-op here, since nothing was ever revoked) and leaves the mirror root unchanged", async () => {
    const mirror = new RevocationRegistry()
    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            return `0x${"11".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            return { status: "reverted" }
        },
        async getRevocationRoot() {
            throw new Error("should not be reached: getRevocationRoot is only read after a successful write")
        },
        async rebuildMirror() {
            return new RevocationRegistry()
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(42n), /reverted/)
    assert.equal(mirror.root, 0n)
    assert.equal(mirror.isRevoked(42n), false)
})

test("concurrent revokes are serialized: each computes its low-leaf index after the previous one lands", async () => {
    const mirror = new RevocationRegistry()
    const calls: string[] = []
    let nextHash = 0

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke(commitment) {
            calls.push(`submit:${commitment}`)
            nextHash += 1
            return `0x${nextHash.toString(16).padStart(64, "0")}` as Hex
        },
        async waitForReceipt(hash) {
            // A delay long enough that a non-serialized implementation would call submitRevoke
            // again before this resolves, making any interleaving observable in `calls`.
            await new Promise((resolve) => setTimeout(resolve, 20))
            calls.push(`receipt:${hash}`)
            return { status: "success" }
        },
        async getRevocationRoot() {
            return mirror.root
        },
        rebuildMirror: unreachableRebuild
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await Promise.all([revoke(1n), revoke(2n)])

    assert.equal(calls.length, 4)
    // Whichever commitment goes first, its receipt must land before the other's submit.
    assert.equal(calls[0].startsWith("submit:"), true)
    assert.equal(calls[1].startsWith("receipt:"), true)
    assert.equal(calls[2].startsWith("submit:"), true)
    assert.equal(calls[3].startsWith("receipt:"), true)
    assert.equal(mirror.isRevoked(1n), true)
    assert.equal(mirror.isRevoked(2n), true)
})

test("a failed revoke does not poison the queue: the next revoke still lands", async () => {
    const mirror = new RevocationRegistry()
    let submitted: bigint | undefined

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke(commitment) {
            submitted = commitment
            return `0x${"66".repeat(32)}` as Hex
        },
        // Keyed on the commitment, not the attempt: 1n must exhaust its retries rather than
        // succeed on the second one.
        async waitForReceipt() {
            return { status: submitted === 1n ? "reverted" : "success" }
        },
        async getRevocationRoot() {
            return mirror.root
        },
        async rebuildMirror() {
            return new RevocationRegistry()
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(1n), /reverted/)
    await revoke(2n)

    assert.equal(mirror.isRevoked(1n), false)
    assert.equal(mirror.isRevoked(2n), true)
    assert.equal(mirror.size, 1)
})

test("on a root mismatch after a write, the mirror is re-synced to what the chain reports before the error propagates", async () => {
    const mirror = new RevocationRegistry()
    // Stands in for "what the chain actually holds": a commitment this revoke() call never made,
    // so a correct re-sync must discard the mirror's own optimistic update and adopt this instead.
    const chainRoot = new RevocationRegistry([777n]).root

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            return `0x${"33".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            return { status: "success" }
        },
        async getRevocationRoot() {
            // Deliberately the chain's root, not the local mirror's: forces the mismatch branch
            // regardless of what committing 42n locally would have produced.
            return chainRoot
        },
        // A fresh registry per call, so a retry's own optimistic revoke can't mutate the state
        // this fixture is meant to keep returning.
        async rebuildMirror() {
            return new RevocationRegistry([777n])
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(42n), /on-chain and mirrored revocation roots differ/)
    assert.equal(mirror.root, chainRoot)
    assert.equal(mirror.isRevoked(777n), true)
    assert.equal(mirror.isRevoked(42n), false)
})

// One tree for the whole network, so a foreign write landing between this one and the root read is
// ordinary. The fixture above cannot show it: its chain never contains the write this call made.
test("a write that landed is reported as done, even when a foreign write moved the root first", async () => {
    const mirror = new RevocationRegistry()
    let submissions = 0

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            submissions += 1
            return `0x${"44".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            return { status: "success" }
        },
        // Another member's commitment is in the tree by the time this read returns, so the root
        // cannot match the one the local mirror computed for its own write alone.
        async getRevocationRoot() {
            return new RevocationRegistry([42n, 777n]).root
        },
        // The chain holds both: this call's write did land.
        async rebuildMirror() {
            return new RevocationRegistry([42n, 777n])
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await revoke(42n)

    assert.equal(submissions, 1)
    assert.equal(mirror.isRevoked(42n), true)
    assert.equal(mirror.isRevoked(777n), true)
})

test("when waitForReceipt itself throws, the mirror is re-synced before the error propagates", async () => {
    const mirror = new RevocationRegistry()
    const chainMirror = new RevocationRegistry([888n])

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            return `0x${"44".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            throw new Error("network error")
        },
        async getRevocationRoot() {
            throw new Error("should not be reached: the receipt wait itself failed")
        },
        async rebuildMirror() {
            return chainMirror
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(42n), /network error/)
    assert.equal(mirror.root, chainMirror.root)
    assert.equal(mirror.isRevoked(888n), true)
    assert.equal(mirror.isRevoked(42n), false)
})

test("when submitRevoke itself rejects, the mirror is re-synced and the next revoke still succeeds", async () => {
    const mirror = new RevocationRegistry()
    // What the chain already held before this attempt, unknown to this mirror until the re-sync —
    // standing in for the state that made this write fail in the first place (e.g. another member's
    // revoke landed first, so the low-leaf index this attempt computed no longer applies).
    const chainMirror = new RevocationRegistry([222n])
    let submissions = 0

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            submissions += 1
            // Every attempt of the first revoke fails, so it exhausts its retries.
            if (submissions <= 3) throw new Error("InvalidLowLeaf")
            return `0x${submissions.toString(16).padStart(64, "0")}` as Hex
        },
        async waitForReceipt() {
            return { status: "success" }
        },
        async getRevocationRoot() {
            return mirror.root
        },
        async rebuildMirror() {
            return chainMirror
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(111n), /InvalidLowLeaf/)
    assert.equal(mirror.root, chainMirror.root)
    assert.equal(mirror.isRevoked(222n), true)
    assert.equal(mirror.isRevoked(111n), false)

    await revoke(111n)
    assert.equal(mirror.isRevoked(111n), true)
    assert.equal(mirror.isRevoked(222n), true)
})

test("when the re-sync itself also fails, the caller still sees the original error, with the re-sync failure attached as cause", async () => {
    const mirror = new RevocationRegistry()
    const resyncError = new Error("rpc unreachable")
    let submissions = 0

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            submissions += 1
            return `0x${"55".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            return { status: "reverted" }
        },
        async getRevocationRoot() {
            throw new Error("should not be reached: getRevocationRoot is only read after a successful write")
        },
        async rebuildMirror() {
            throw resyncError
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(42n), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /reverted/)
        // This lib target predates Error.cause, same as where revocation.ts sets it.
        assert.equal((error as Error & { cause?: unknown }).cause, resyncError)
        return true
    })
    // A mirror that could not be refreshed makes the next index just as stale, so the attempts stop.
    assert.equal(submissions, 1)
})

test("a reverted stale index is retried with the same proof after a re-sync, and the second attempt lands", async () => {
    const mirror = new RevocationRegistry()
    // A foreign member's revoke, landed between this call computing its index and submitting it.
    const chainMirror = new RevocationRegistry([500n])
    const submits: { lowLeafIndex: bigint; proof: NetworkMemberProof }[] = []
    let resynced = false

    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke(_commitment, lowLeafIndex, proof) {
            submits.push({ lowLeafIndex, proof })
            return `0x${submits.length.toString(16).padStart(64, "0")}` as Hex
        },
        async waitForReceipt() {
            return { status: resynced ? "success" : "reverted" }
        },
        async getRevocationRoot() {
            return mirror.root
        },
        async rebuildMirror() {
            resynced = true
            return chainMirror
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await revoke(600n)

    assert.equal(submits.length, 2)
    // The index is recomputed off the re-synced mirror, so 500n is now 600n's predecessor.
    assert.notEqual(submits[0].lowLeafIndex, submits[1].lowLeafIndex)
    // The same proof, not a new one: the message never bound the index, and the reverted call took
    // Semaphore's nullifier write with it.
    assert.equal(submits[0].proof, submits[1].proof)
    assert.equal(mirror.isRevoked(600n), true)
})

test("a proof is generated once per commitment, not once per attempt", async () => {
    const mirror = new RevocationRegistry()
    const proved: bigint[] = []

    const ops: RevokeChainOps = {
        async proveRevocation(commitment) {
            proved.push(commitment)
            return proofFor(commitment)
        },
        async submitRevoke() {
            return `0x${"77".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            return { status: "reverted" }
        },
        async getRevocationRoot() {
            throw new Error("should not be reached: getRevocationRoot is only read after a successful write")
        },
        async rebuildMirror() {
            return new RevocationRegistry()
        }
    }
    const { revoke } = createSerializedRevoke(mirror, ops)

    await assert.rejects(revoke(42n), /reverted/)

    assert.deepEqual(proved, [42n])
})
