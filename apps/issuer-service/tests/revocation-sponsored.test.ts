import assert from "node:assert/strict"
import { test } from "node:test"
import { toFunctionSelector } from "viem"
import type { Address, Hex } from "viem"
import { buildSponsoredRevocation } from "../src/revocation"
import type { SponsoredRevocationBackingConfig } from "../src/revocation"
import { CHAIN_ID, ENTRY_POINT, RPC_URL, SPONSORED, addressResult, mockSponsoredRpc, uintResult } from "./sponsored-rpc"
import type { Call } from "./sponsored-rpc"

const REGISTRY_ADDRESS = `0x${"cc".repeat(20)}` as Address
const SERVICE_ADDRESS = `0x${"dd".repeat(20)}` as Address
const SEMAPHORE_ADDRESS = `0x${"ee".repeat(20)}` as Address
const REGISTRY_ID = 5n

const REVOCATION_SELECTOR = toFunctionSelector("function REVOCATION() view returns (address)")
const REGISTRY_ID_SELECTOR = toFunctionSelector("function REGISTRY_ID() view returns (uint256)")
const SEMAPHORE_SELECTOR = toFunctionSelector("function SEMAPHORE() view returns (address)")
const NETWORK_MEMBER_GROUP_ID_SELECTOR = toFunctionSelector("function NETWORK_MEMBER_GROUP_ID() view returns (uint256)")

/** The registry's getters; every other read answers 0, which is an empty tree whose root is 0. */
function registryReads({ data }: Call): Hex {
    if (data.startsWith(REVOCATION_SELECTOR)) return addressResult(SERVICE_ADDRESS)
    if (data.startsWith(REGISTRY_ID_SELECTOR)) return uintResult(REGISTRY_ID)
    if (data.startsWith(SEMAPHORE_SELECTOR)) return addressResult(SEMAPHORE_ADDRESS)
    if (data.startsWith(NETWORK_MEMBER_GROUP_ID_SELECTOR)) return uintResult(3n)
    return uintResult(0n)
}

// No memberPrivateKey: nothing here could build a DirectRevocationWriter.
const config: SponsoredRevocationBackingConfig = {
    address: REGISTRY_ADDRESS,
    memberIdentitySecret: new Uint8Array(32).fill(0x22),
    memberGroupFromBlock: 0,
    sponsored: SPONSORED
}

const fakeBase = {
    isApprovedNetworkMember: async () => true,
    getCredentialPublicKey: async () => null,
    isRevoked: async () => false,
    revoke: async () => {}
}

test("a sponsored revocation builds from a config with no member key and sends no transaction itself", async () => {
    const rpc = mockSponsoredRpc({ onCall: registryReads })
    try {
        const revocation = await buildSponsoredRevocation(config, RPC_URL, fakeBase)

        assert.equal(revocation.registryAddress?.toLowerCase(), SERVICE_ADDRESS)
        assert.equal(revocation.registryId, REGISTRY_ID)
        assert.ok(!rpc.rpcMethods.some((method) => method.startsWith("eth_send")))
        assert.deepEqual(new Set(rpc.bundlerMethods), new Set(["eth_supportedEntryPoints", "eth_chainId"]))
    } finally {
        rpc.restore()
    }
})

test("a bundler serving another chain stops the build, without its URL", async () => {
    const rpc = mockSponsoredRpc({ onCall: registryReads, bundlerChainId: CHAIN_ID + 1 })
    try {
        await assert.rejects(
            () => buildSponsoredRevocation(config, RPC_URL, fakeBase),
            (error: Error) =>
                error.message === `the bundler serves chain ${CHAIN_ID + 1}, not this deployment's chain ${CHAIN_ID}` &&
                !error.message.includes("key-abc123")
        )
    } finally {
        rpc.restore()
    }
})

test("a bundler that does not serve the EntryPoint stops the build, without its URL", async () => {
    const rpc = mockSponsoredRpc({ onCall: registryReads, bundlerEntryPoints: [] })
    try {
        await assert.rejects(
            () => buildSponsoredRevocation(config, RPC_URL, fakeBase),
            (error: Error) => /does not serve EntryPoint/.test(error.message) && !error.message.includes("key-abc123")
        )
    } finally {
        rpc.restore()
    }
})

test("an EntryPoint with no code stops the build", async () => {
    const rpc = mockSponsoredRpc({ onCall: registryReads, noCodeAt: [ENTRY_POINT] })
    try {
        await assert.rejects(
            () => buildSponsoredRevocation(config, RPC_URL, fakeBase),
            /no contract at ENTRY_POINT_ADDRESS/
        )
    } finally {
        rpc.restore()
    }
})
