import { describe, expect, it } from "@jest/globals"
import { IssuerRegistry, SHA256_VALUE_BOUND, SNARK_SCALAR_FIELD, sha256Scheme } from "../src"
import type { IssuerScheme } from "../src"

/** The same roots are pinned on chain in `IssuerRegistryCrossLanguageRoot.t.sol` and its SHA-256 variant. */
describe.each([
    {
        name: "Poseidon",
        scheme: undefined as IssuerScheme | undefined,
        max: SNARK_SCALAR_FIELD - 1n,
        roots: {
            ascending: 3925045059169335782833407477321845405342042180089864692501953598893457304808n,
            unsorted: 19859590655771910700590144031884476876350423465228809141242344822195565097368n,
            removed: 5669516470378802616293624245697922982622946828131598763076682078386975990445n,
            updated: 10961825507292970642995133391392839183635325099968459091901054002589842274376n,
            top: 11864977421243360970430964084020268000962783534283303225545691252049900955005n,
            reAdded: 10121527940021409969512850627702146629668767621816708257596873663802416109299n
        }
    },
    {
        name: "SHA-256",
        scheme: sha256Scheme,
        max: SHA256_VALUE_BOUND - 1n,
        roots: {
            ascending: 93805080911137514286305664785970201255654020885154000348023179261022723795396n,
            unsorted: 101303635641675734763162662120683549442686812240429308935070736332954422789383n,
            removed: 13096474889912315376180021488918777854187494384453769718354334942754899487001n,
            updated: 101999388321653114002087667412150585743282582468049496342203867694175678013490n,
            top: 41375872462068963710440837698392059863240512031509844620661314680615792752993n,
            reAdded: 25268371512384373375842063580923886211184797836584604430972420561298243153889n
        }
    }
])("cross-language roots, $name scheme", ({ scheme, max, roots }) => {
    it("matches the contract for an ascending insertion order", () => {
        expect(new IssuerRegistry([100n, 200n, 300n], scheme).root).toBe(roots.ascending)
    })

    it("matches the contract for an unsorted batch", () => {
        expect(new IssuerRegistry([300n, 100n, 200n, 50n, 900n], scheme).root).toBe(roots.unsorted)
    })

    it("matches the contract after a removal", () => {
        const registry = new IssuerRegistry([100n, 200n, 300n], scheme)

        registry.removeIssuer(200n)

        expect(registry.root).toBe(roots.removed)
    })

    it("matches the contract after an in-place update", () => {
        const registry = new IssuerRegistry([100n, 200n, 300n], scheme)

        registry.updateIssuerCommitment(200n, 400n)

        expect(registry.root).toBe(roots.updated)
    })

    it("matches the contract at the top of the value range", () => {
        expect(new IssuerRegistry([max, 1n, max - 7n], scheme).root).toBe(roots.top)
    })

    it("matches the contract's leaves and root after removals and a re-add", () => {
        const registry = new IssuerRegistry([100n, 200n, 300n, 400n, 500n], scheme)

        registry.removeIssuer(100n)
        registry.removeIssuer(500n)
        registry.addIssuer(100n)

        expect(registry.leaves).toEqual([0n, 200n, 300n, 400n, 0n, 100n])
        expect(registry.root).toBe(roots.reAdded)
    })
})
