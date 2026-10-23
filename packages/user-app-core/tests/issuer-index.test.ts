import { describe, expect, it } from "@jest/globals"
import { MemoryStore, type Store } from "@coordination-network/wallet"
import {
    deleteIssuerEntries,
    listIssuerEntries,
    readIssuerEntry,
    writeIssuerEntry,
    type IssuerIndexEntry
} from "../src/issuer-index"

describe("issuer index", () => {
    const issuerNetworkId = `0x${"AB".repeat(32)}` as const
    const otherIssuerNetworkId = `0x${"cd".repeat(32)}` as const
    const scope = { programme: "demo-programme", country: "ZZZ" }

    function entry(overrides: Partial<IssuerIndexEntry> = {}): IssuerIndexEntry {
        return {
            credentialId: "cred-1",
            issuerPublicKey: ["11", "22"],
            issuersUrl: "https://issuer.example/v1/issuers",
            programme: "demo-programme",
            country: "ZZZ",
            issuedAt: 1_760_000_000,
            ...overrides
        }
    }

    it("returns null for an issuer with no stored credential", async () => {
        expect(await readIssuerEntry(new MemoryStore(), issuerNetworkId, scope)).toBeNull()
    })

    it("round-trips an entry, case-insensitively on the issuer id", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry())

        expect(await readIssuerEntry(store, issuerNetworkId.toLowerCase() as typeof issuerNetworkId, scope)).toEqual(
            entry()
        )
    })

    it("skips a key that is gone by the time it is read", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry())
        const vanishing: Store = {
            list: () => store.list(),
            get: async () => null,
            set: (key, value) => store.set(key, value),
            delete: (key) => store.delete(key)
        }

        expect(await listIssuerEntries(vanishing)).toEqual([])
    })

    // The presentation handler starts from these: each names the snapshot that governs one
    // credential, which is the only thing that can say whether it is revoked.
    it("lists every issuer with the id it is keyed under", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry())
        await writeIssuerEntry(store, otherIssuerNetworkId, entry({ credentialId: "cred-2" }))
        await store.set("vc:cred-1", "a credential record, not an index entry")

        const listed = await listIssuerEntries(store)

        expect(listed).toHaveLength(2)
        expect(listed.map(({ issuerNetworkId: id, credentialId }) => [id, credentialId]).sort()).toEqual([
            [issuerNetworkId.toLowerCase(), "cred-1"],
            [otherIssuerNetworkId, "cred-2"]
        ])
    })

    it("keeps one entry per approval scope, so an issuer running two programmes gets two", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry())
        await writeIssuerEntry(store, issuerNetworkId, entry({ credentialId: "cred-2", programme: "alt-programme" }))
        await writeIssuerEntry(store, issuerNetworkId, entry({ credentialId: "cred-3", country: "ZZY" }))

        expect(await readIssuerEntry(store, issuerNetworkId, scope)).toMatchObject({ credentialId: "cred-1" })
        expect((await listIssuerEntries(store)).map(({ credentialId }) => credentialId).sort()).toEqual([
            "cred-1",
            "cred-2",
            "cred-3"
        ])
    })

    // A programme name is a caller-supplied string; unescaped it could land on another scope's key.
    it("keeps a programme carrying the key separator on its own key", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry({ programme: "demo:ZZZ:extra" }))
        await writeIssuerEntry(store, issuerNetworkId, entry({ credentialId: "cred-2" }))

        expect(await readIssuerEntry(store, issuerNetworkId, scope)).toMatchObject({ credentialId: "cred-2" })
        expect(
            await readIssuerEntry(store, issuerNetworkId, { programme: "demo:ZZZ:extra", country: "ZZZ" })
        ).toMatchObject({ credentialId: "cred-1" })
        expect(await listIssuerEntries(store)).toHaveLength(2)
    })

    it("deletes only the entries naming the given credentials", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry())
        await writeIssuerEntry(store, issuerNetworkId, entry({ credentialId: "cred-2", programme: "alt-programme" }))
        await writeIssuerEntry(store, otherIssuerNetworkId, entry({ credentialId: "cred-3" }))
        await store.set("vc:cred-1", "a credential record, not an index entry")

        await deleteIssuerEntries(store, new Set(["cred-1", "cred-3"]))

        expect((await listIssuerEntries(store)).map(({ credentialId }) => credentialId)).toEqual(["cred-2"])
        expect(await store.get("vc:cred-1")).not.toBeNull()
    })

    it("skips an entry it cannot parse, leaving it in place, and still deletes the rest", async () => {
        const store = new MemoryStore()
        const corruptKey = "user-app-core:issuer-index:0x00:corrupt:ZZZ"
        await store.set(corruptKey, "{not json")
        await writeIssuerEntry(store, issuerNetworkId, entry())
        await writeIssuerEntry(store, otherIssuerNetworkId, entry({ credentialId: "cred-2" }))

        await deleteIssuerEntries(store, new Set(["cred-1", "cred-2"]))

        expect(await store.list()).toEqual([corruptKey])
    })

    it("skips a key that is gone by the time it is deleted", async () => {
        const store = new MemoryStore()
        await writeIssuerEntry(store, issuerNetworkId, entry())
        const vanishing: Store = {
            list: () => store.list(),
            get: async () => null,
            set: (key, value) => store.set(key, value),
            delete: (key) => store.delete(key)
        }

        await deleteIssuerEntries(vanishing, new Set(["cred-1"]))

        expect(await listIssuerEntries(store)).toHaveLength(1)
    })
})
