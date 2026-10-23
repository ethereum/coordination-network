import { describe, expect, it, jest } from "@jest/globals"
import type { Hex32 } from "@coordination-network/credential"
import type { Address, Hex } from "@coordination-network/identity"
import { buildRegistrationRequest, onboard } from "@coordination-network/user-client"
import type { ChainDomain } from "@coordination-network/user-client"
import { UpdateAction } from "@coordination-network/network-member-proof"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import { NetworkMemberClientError, RegistryRevertError } from "../src/errors"
import { submitRegistration } from "../src/submit"
import type { IdentityReader, RegistrationProver, RegistrationWriter } from "../src/types"

const DEVICE_SECRET: Hex = `0x${"11".repeat(32)}`
const DOMAIN: ChainDomain = { chainId: 31337, verifyingContract: `0x${"aa".repeat(20)}` as Hex }
const REGISTRY: RegistryLocation = { chainId: BigInt(DOMAIN.chainId), address: DOMAIN.verifyingContract }

const FIXED_PROOF: NetworkMemberProof = {
    merkleTreeDepth: 1n,
    merkleTreeRoot: 0n,
    nullifier: 0n,
    scope: 0n,
    points: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]
}

function buildRequest() {
    const { keys, networkId, metaStealthAddress } = onboard(DEVICE_SECRET)
    return { networkId, metaStealthAddress, request: buildRegistrationRequest(keys, DOMAIN) }
}

function unusedProver(registry: RegistryLocation = REGISTRY): RegistrationProver {
    return { registry, prove: jest.fn<RegistrationProver["prove"]>() }
}

function unusedWriter(registry: RegistryLocation = REGISTRY): RegistrationWriter {
    return { registry, registerIdentity: jest.fn<RegistrationWriter["registerIdentity"]>() }
}

class FixedIdentityReader implements IdentityReader {
    constructor(private readonly identities: Partial<Record<Hex32, Hex>>) {}

    async getIdentity(networkId: Hex32): Promise<Hex | null> {
        return this.identities[networkId] ?? null
    }
}

describe("submitRegistration", () => {
    it("submits a fresh registration and returns the write's tx hash", async () => {
        const { networkId, metaStealthAddress, request } = buildRequest()
        const identityReader = new FixedIdentityReader({})
        const prove = jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF)
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => ({
            txHash: "0xtxhash" as Hex
        }))

        const result = await submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove },
            writer: { registry: REGISTRY, registerIdentity }
        })

        expect(result).toEqual({ status: "submitted", networkId, metaStealthAddress, txHash: "0xtxhash" })
        expect(prove).toHaveBeenCalledWith({ action: UpdateAction.Register, networkId, metaStealthAddress })
        expect(registerIdentity).toHaveBeenCalledWith(networkId, metaStealthAddress, FIXED_PROOF)
    })

    it("spreads a sponsored write's sponsorship into the submitted result", async () => {
        const { networkId, metaStealthAddress, request } = buildRequest()
        const identityReader = new FixedIdentityReader({})
        const prove = jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF)
        const sponsorship = {
            sender: `0x${"11".repeat(20)}` as Address,
            senderBalanceBefore: 0n,
            senderBalanceAfter: 0n,
            userOpHash: `0x${"22".repeat(32)}` as Hex,
            bundleTxHash: "0xtxhash" as Hex,
            actualGasCost: 123n,
            paymaster: `0x${"33".repeat(20)}` as Address,
            paymasterDepositBefore: 1000n,
            paymasterDepositAfter: 877n
        }
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => ({
            txHash: "0xtxhash" as Hex,
            sponsorship
        }))

        const result = await submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove },
            writer: { registry: REGISTRY, registerIdentity }
        })

        expect(result).toEqual({
            status: "submitted",
            networkId,
            metaStealthAddress,
            txHash: "0xtxhash",
            sponsorship
        })
    })

    it("throws before any port call when the prover targets a different registry than domain", async () => {
        const { request } = buildRequest()
        const identityReader: IdentityReader = { getIdentity: jest.fn<IdentityReader["getIdentity"]>() }
        const otherRegistry: RegistryLocation = { ...REGISTRY, address: `0x${"ff".repeat(20)}` as Hex }
        const prover = unusedProver(otherRegistry)
        const writer = unusedWriter()

        const submission = submitRegistration(request, { domain: DOMAIN, identityReader, prover, writer })

        await expect(submission).rejects.toThrow(/prover/)
        await expect(submission).rejects.not.toBeInstanceOf(NetworkMemberClientError)
        expect(identityReader.getIdentity).not.toHaveBeenCalled()
    })

    it("throws before any port call when the writer targets a different chain than domain", async () => {
        const { request } = buildRequest()
        const identityReader: IdentityReader = { getIdentity: jest.fn<IdentityReader["getIdentity"]>() }
        const prover = unusedProver()
        const otherRegistry: RegistryLocation = { ...REGISTRY, chainId: REGISTRY.chainId + 1n }
        const writer = unusedWriter(otherRegistry)

        const submission = submitRegistration(request, { domain: DOMAIN, identityReader, prover, writer })

        await expect(submission).rejects.toThrow(/writer/)
        await expect(submission).rejects.not.toBeInstanceOf(NetworkMemberClientError)
        expect(identityReader.getIdentity).not.toHaveBeenCalled()
    })

    it("throws before any port call when the identityReader targets a different registry than domain", async () => {
        const { request } = buildRequest()
        const getIdentity = jest.fn<IdentityReader["getIdentity"]>()
        const identityReader: IdentityReader = { registryAddress: `0x${"ff".repeat(20)}` as Address, getIdentity }
        const prover = unusedProver()
        const writer = unusedWriter()

        const submission = submitRegistration(request, { domain: DOMAIN, identityReader, prover, writer })

        await expect(submission).rejects.toThrow(/identityReader/)
        await expect(submission).rejects.not.toBeInstanceOf(NetworkMemberClientError)
        expect(getIdentity).not.toHaveBeenCalled()
    })

    it("proceeds when the identityReader reports no registryAddress", async () => {
        const { networkId, metaStealthAddress, request } = buildRequest()
        // FixedIdentityReader carries no registryAddress: the check is a no-op for readers that
        // don't report where they point.
        const identityReader = new FixedIdentityReader({})
        const prove = jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF)
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => ({
            txHash: "0xtxhash" as Hex
        }))

        const result = await submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove },
            writer: { registry: REGISTRY, registerIdentity }
        })

        expect(result).toEqual({ status: "submitted", networkId, metaStealthAddress, txHash: "0xtxhash" })
    })

    it("rejects a request whose signature does not verify, before touching any port", async () => {
        const { request } = buildRequest()
        const forged = { ...request, signature: `0x${"00".repeat(65)}` as Hex }
        const identityReader: IdentityReader = { getIdentity: jest.fn<IdentityReader["getIdentity"]>() }
        const prover = unusedProver()
        const writer = unusedWriter()

        const submission = submitRegistration(forged, { domain: DOMAIN, identityReader, prover, writer })

        await expect(submission).rejects.toThrow(NetworkMemberClientError)
        await expect(submission).rejects.toMatchObject({ code: "INVALID_REGISTRATION_REQUEST" })
        expect(identityReader.getIdentity).not.toHaveBeenCalled()
        expect(prover.prove).not.toHaveBeenCalled()
    })

    it("rejects a request signed against a different registry domain", async () => {
        const { request } = buildRequest()
        const otherDomain: ChainDomain = { ...DOMAIN, chainId: 999 }
        const otherRegistry: RegistryLocation = { ...REGISTRY, chainId: 999n }
        const identityReader: IdentityReader = { getIdentity: jest.fn<IdentityReader["getIdentity"]>() }
        const prover = unusedProver(otherRegistry)
        const writer = unusedWriter(otherRegistry)

        const submission = submitRegistration(request, { domain: otherDomain, identityReader, prover, writer })

        await expect(submission).rejects.toMatchObject({ code: "INVALID_REGISTRATION_REQUEST" })
        expect(identityReader.getIdentity).not.toHaveBeenCalled()
    })

    it("returns alreadyRegistered with matchesRequest true when the stored entry matches the request", async () => {
        const { networkId, metaStealthAddress, request } = buildRequest()
        const identityReader = new FixedIdentityReader({ [networkId]: metaStealthAddress })
        const prover = unusedProver()
        const writer = unusedWriter()

        const result = await submitRegistration(request, { domain: DOMAIN, identityReader, prover, writer })

        expect(result).toEqual({ status: "alreadyRegistered", networkId, metaStealthAddress, matchesRequest: true })
        expect(prover.prove).not.toHaveBeenCalled()
        expect(writer.registerIdentity).not.toHaveBeenCalled()
    })

    it("returns alreadyRegistered with matchesRequest false when the stored entry differs from the request", async () => {
        const { networkId, request } = buildRequest()
        const existing = `0x${"cc".repeat(66)}` as Hex
        const identityReader = new FixedIdentityReader({ [networkId]: existing })
        const prover = unusedProver()
        const writer = unusedWriter()

        const result = await submitRegistration(request, { domain: DOMAIN, identityReader, prover, writer })

        expect(result).toEqual({
            status: "alreadyRegistered",
            networkId,
            metaStealthAddress: existing,
            matchesRequest: false
        })
        expect(prover.prove).not.toHaveBeenCalled()
        expect(writer.registerIdentity).not.toHaveBeenCalled()
    })

    it("maps a registry read failure to REGISTRY_UNAVAILABLE", async () => {
        const { networkId, request } = buildRequest()
        const identityReader: IdentityReader = {
            getIdentity: jest.fn<IdentityReader["getIdentity"]>(async () => {
                throw new Error("rpc down")
            })
        }

        const submission = submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: unusedProver(),
            writer: unusedWriter()
        })

        await expect(submission).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" })
        await expect(submission).rejects.toMatchObject({ message: expect.not.stringContaining(networkId) })
    })

    it("resolves a lost AlreadyRegistered race by re-reading the entry", async () => {
        const { networkId, request } = buildRequest()
        const raced = `0x${"dd".repeat(66)}` as Hex
        let registered = false
        const identityReader: IdentityReader = {
            getIdentity: jest.fn<IdentityReader["getIdentity"]>(async () => (registered ? raced : null))
        }
        const prove = jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF)
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => {
            registered = true
            throw new RegistryRevertError("AlreadyRegistered")
        })

        const result = await submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove },
            writer: { registry: REGISTRY, registerIdentity }
        })

        expect(result).toEqual({
            status: "alreadyRegistered",
            networkId,
            metaStealthAddress: raced,
            matchesRequest: false
        })
    })

    it("rethrows the original AlreadyRegistered revert when a raced re-read still returns null", async () => {
        const { request } = buildRequest()
        const identityReader: IdentityReader = { getIdentity: jest.fn<IdentityReader["getIdentity"]>(async () => null) }
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => {
            throw new RegistryRevertError("AlreadyRegistered")
        })

        const submission = submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove: jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF) },
            writer: { registry: REGISTRY, registerIdentity }
        })

        await expect(submission).rejects.toBeInstanceOf(RegistryRevertError)
        await expect(submission).rejects.toMatchObject({
            code: "REGISTRATION_REJECTED",
            errorName: "AlreadyRegistered"
        })
    })

    it("rethrows the original AlreadyRegistered revert when the raced re-read itself fails", async () => {
        const { request } = buildRequest()
        let reads = 0
        const identityReader: IdentityReader = {
            getIdentity: jest.fn<IdentityReader["getIdentity"]>(async () => {
                reads += 1
                if (reads === 1) return null
                throw new Error("rpc down")
            })
        }
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => {
            throw new RegistryRevertError("AlreadyRegistered")
        })

        const submission = submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove: jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF) },
            writer: { registry: REGISTRY, registerIdentity }
        })

        await expect(submission).rejects.toBeInstanceOf(RegistryRevertError)
        await expect(submission).rejects.toMatchObject({
            code: "REGISTRATION_REJECTED",
            errorName: "AlreadyRegistered"
        })
    })

    it("propagates a non-AlreadyRegistered revert as REGISTRATION_REJECTED", async () => {
        const { request } = buildRequest()
        const identityReader = new FixedIdentityReader({})
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => {
            throw new RegistryRevertError("Semaphore__InvalidProof")
        })

        const submission = submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove: jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF) },
            writer: { registry: REGISTRY, registerIdentity }
        })

        await expect(submission).rejects.toBeInstanceOf(RegistryRevertError)
        await expect(submission).rejects.toMatchObject({
            code: "REGISTRATION_REJECTED",
            errorName: "Semaphore__InvalidProof"
        })
    })

    it("maps a writer transport failure to REGISTRY_UNAVAILABLE", async () => {
        const { networkId, request } = buildRequest()
        const identityReader = new FixedIdentityReader({})
        const registerIdentity = jest.fn<RegistrationWriter["registerIdentity"]>(async () => {
            throw new Error("connection reset")
        })

        const submission = submitRegistration(request, {
            domain: DOMAIN,
            identityReader,
            prover: { registry: REGISTRY, prove: jest.fn<RegistrationProver["prove"]>(async () => FIXED_PROOF) },
            writer: { registry: REGISTRY, registerIdentity }
        })

        await expect(submission).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" })
        await expect(submission).rejects.toMatchObject({ message: expect.not.stringContaining(networkId) })
    })
})
