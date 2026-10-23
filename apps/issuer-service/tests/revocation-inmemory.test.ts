import assert from "node:assert/strict"
import { test } from "node:test"
import { Jwk, Resolver, RevocationWriter } from "@coordination-network/credential"
import { createInMemoryRevocation } from "../src/revocation"

/** A `Resolver & RevocationWriter` that records every `revoke` call, standing in for a caller's own
 *  chain-writing resolver (e.g. `apps/integration-testbed/src/revocation-resolver.ts`). */
function createRecordingBase(): Resolver & RevocationWriter & { revokedCalls: bigint[] } {
    const revoked = new Set<string>()
    return {
        revokedCalls: [] as bigint[],
        async isApprovedNetworkMember() {
            return false
        },
        async getCredentialPublicKey(): Promise<Jwk | null> {
            return null
        },
        async isRevoked(commitment: bigint) {
            return revoked.has(commitment.toString())
        },
        async revoke(commitment: bigint) {
            this.revokedCalls.push(commitment)
            revoked.add(commitment.toString())
        }
    }
}

test("createInMemoryRevocation delegates revoke to the base resolver before updating its own mirror", async () => {
    const base = createRecordingBase()
    const backing = createInMemoryRevocation(base)

    assert.equal(await backing.isRevoked(42n), false)

    await backing.revoke(42n)

    assert.deepEqual(base.revokedCalls, [42n])
    assert.equal(await base.isRevoked(42n), true)
    assert.equal(backing.mirror.isRevoked(42n), true)
    assert.equal(await backing.isRevoked(42n), true)
})

test("createInMemoryRevocation leaves its mirror untouched when the base resolver rejects", async () => {
    const base = createRecordingBase()
    base.revoke = async () => {
        throw new Error("base rejected")
    }
    const backing = createInMemoryRevocation(base)

    await assert.rejects(backing.revoke(99n), /base rejected/)
    assert.equal(backing.mirror.isRevoked(99n), false)
})

test("createInMemoryRevocation has nothing to catch up with: refresh leaves its mirror alone", async () => {
    const base = createRecordingBase()
    const backing = createInMemoryRevocation(base)
    await backing.revoke(5n)
    const root = backing.mirror.root

    await backing.refresh()

    assert.equal(backing.mirror.root, root)
    assert.equal(backing.isRevokedLocally(5n), true)
})

test("createInMemoryRevocation's isRevoked is true when either the base or the mirror has the commitment", async () => {
    const base = createRecordingBase()
    const backing = createInMemoryRevocation(base)

    // The base already knows about this commitment (e.g. revoked through some other path); this
    // backing's own mirror never saw it.
    await base.revoke(7n)
    assert.equal(backing.mirror.isRevoked(7n), false)
    assert.equal(await backing.isRevoked(7n), true)
})
