import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex } from "viem"
import { NetworkMemberProof } from "@coordination-network/network-member-proof"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { createSerializedRevoke, RevokeChainOps } from "../src/revocation"

const proveRevocation = async (commitment: bigint): Promise<NetworkMemberProof> => ({
    merkleTreeDepth: 1n,
    merkleTreeRoot: 2n,
    nullifier: commitment,
    scope: 4n,
    points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]
})

const noWrites = {
    proveRevocation,
    async submitRevoke(): Promise<Hex> {
        throw new Error("should not be reached: this case never writes")
    },
    async waitForReceipt(): Promise<{ status: "success" | "reverted" }> {
        throw new Error("should not be reached: this case never writes")
    }
}

test("refresh reads the root and stops there when the network has not moved", async () => {
    const mirror = new RevocationRegistry()
    let rootReads = 0
    const ops: RevokeChainOps = {
        ...noWrites,
        async getRevocationRoot() {
            rootReads += 1
            return mirror.root
        },
        async rebuildMirror() {
            throw new Error("should not be reached: a rebuild costs the whole tree and the root matched")
        }
    }

    await createSerializedRevoke(mirror, ops).refresh()

    assert.equal(rootReads, 1)
})

test("refresh rebuilds the mirror, so a revocation another member landed becomes visible", async () => {
    const mirror = new RevocationRegistry()
    // The tree as another member left it: one this process never wrote to and is never told about.
    const chain = new RevocationRegistry()
    chain.revoke(7n)
    const ops: RevokeChainOps = {
        ...noWrites,
        getRevocationRoot: async () => chain.root,
        rebuildMirror: async () => chain
    }
    const { refresh } = createSerializedRevoke(mirror, ops)

    assert.equal(mirror.isRevoked(7n), false)

    await refresh()

    // The same object /v1/revocations/snapshot holds a reference to, not a replacement for it.
    assert.equal(mirror.isRevoked(7n), true)
    assert.equal(mirror.root, chain.root)
})

test("a refresh waits for a revoke in flight, rather than rebuilding under its root check", async () => {
    const mirror = new RevocationRegistry()
    const order: string[] = []
    const ops: RevokeChainOps = {
        proveRevocation,
        async submitRevoke() {
            return `0x${"22".repeat(32)}` as Hex
        },
        async waitForReceipt() {
            // Long enough that a refresh sharing no queue with the write would land inside this.
            await new Promise((resolve) => setTimeout(resolve, 20))
            return { status: "success" }
        },
        async getRevocationRoot() {
            order.push("root")
            return mirror.root
        },
        async rebuildMirror() {
            order.push("rebuild")
            return mirror
        }
    }
    const { revoke, refresh } = createSerializedRevoke(mirror, ops)

    await Promise.all([revoke(3n), refresh()])

    // The write's own post-write root check, then the refresh's read; no rebuild between them.
    assert.deepEqual(order, ["root", "root"])
    assert.equal(mirror.isRevoked(3n), true)
})
