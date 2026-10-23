import assert from "node:assert/strict"
import { test } from "node:test"
import { InMemoryResolver } from "@coordination-network/credential"
import { IdentityRegistryClient, SponsoredAnnouncementSubmitter } from "@coordination-network/network-member-client"
import { loadConfig } from "../src/config"
import { buildSponsoredDeliveryPorts } from "../src/delivery-ports"
import type { SponsoredDeliveryConfig } from "../src/delivery-ports"
import { ACCOUNT_IMPLEMENTATION, CHAIN_ID, ENTRY_POINT, RPC_URL, SPONSORED, mockSponsoredRpc } from "./sponsored-rpc"

const config: SponsoredDeliveryConfig = {
    identityRegistryAddress: `0x${"aa".repeat(20)}`,
    chainId: CHAIN_ID,
    announcerAddress: `0x${"bb".repeat(20)}`,
    memberIdentitySecret: new Uint8Array(32).fill(0x33),
    sponsored: SPONSORED
}

const approval = new InMemoryResolver()

test("wires an identity reader and a sponsored announcement submitter, with no transaction sent", async () => {
    const rpc = mockSponsoredRpc()
    try {
        const ports = await buildSponsoredDeliveryPorts(config, RPC_URL, approval)

        assert.ok(ports.submitter instanceof SponsoredAnnouncementSubmitter)
        assert.equal(ports.submitter.announcerAddress, config.announcerAddress)
        assert.ok(ports.identityReader instanceof IdentityRegistryClient)
        assert.equal(ports.approval, approval)
        assert.ok(!rpc.rpcMethods.some((method) => method.startsWith("eth_send")))
        assert.deepEqual(new Set(rpc.bundlerMethods), new Set(["eth_supportedEntryPoints", "eth_chainId"]))
    } finally {
        rpc.restore()
    }
})

test("rejects a config pointing at the wrong chain before touching the bundler", async () => {
    const rpc = mockSponsoredRpc()
    try {
        await assert.rejects(
            () => buildSponsoredDeliveryPorts({ ...config, chainId: CHAIN_ID + 1 }, RPC_URL, approval),
            /RPC at .* reports chain/
        )
        assert.deepEqual(rpc.bundlerMethods, [])
    } finally {
        rpc.restore()
    }
})

test("rejects a bundler serving another chain, without its URL", async () => {
    const rpc = mockSponsoredRpc({ bundlerChainId: CHAIN_ID + 1 })
    try {
        await assert.rejects(
            () => buildSponsoredDeliveryPorts(config, RPC_URL, approval),
            (error: Error) =>
                error.message === `the bundler serves chain ${CHAIN_ID + 1}, not this deployment's chain ${CHAIN_ID}` &&
                !error.message.includes("key-abc123")
        )
    } finally {
        rpc.restore()
    }
})

test("rejects a bundler that does not serve the EntryPoint, without its URL", async () => {
    const rpc = mockSponsoredRpc({ bundlerEntryPoints: [] })
    try {
        await assert.rejects(
            () => buildSponsoredDeliveryPorts(config, RPC_URL, approval),
            (error: Error) => /does not serve EntryPoint/.test(error.message) && !error.message.includes("key-abc123")
        )
    } finally {
        rpc.restore()
    }
})

test("rejects an EntryPoint with no code", async () => {
    const rpc = mockSponsoredRpc({ noCodeAt: [ENTRY_POINT] })
    try {
        await assert.rejects(
            () => buildSponsoredDeliveryPorts(config, RPC_URL, approval),
            /no contract at ENTRY_POINT_ADDRESS/
        )
    } finally {
        rpc.restore()
    }
})

test("rejects an account implementation with no code", async () => {
    const rpc = mockSponsoredRpc({ noCodeAt: [ACCOUNT_IMPLEMENTATION] })
    try {
        await assert.rejects(
            () => buildSponsoredDeliveryPorts(config, RPC_URL, approval),
            /no contract at ACCOUNT_IMPLEMENTATION_ADDRESS/
        )
    } finally {
        rpc.restore()
    }
})

test("takes loadConfig's delivery straight", async () => {
    const rpc = mockSponsoredRpc()
    try {
        const { sponsored } = config
        const { delivery } = loadConfig({
            RPC_URL,
            MEMBER_SERVER_TOKEN: "a-member-server-token-long-enough",
            ALLOW_IN_MEMORY_REVOCATION: "true",
            ANNOUNCER_ADDRESS: config.announcerAddress,
            IDENTITY_REGISTRY_ADDRESS: config.identityRegistryAddress,
            CHAIN_ID: String(CHAIN_ID),
            MEMBER_IDENTITY_SECRET: "33".repeat(32),
            ENTRY_POINT_ADDRESS: sponsored.entryPoint,
            PAYMASTER_ADDRESS: sponsored.paymaster,
            ACCOUNT_IMPLEMENTATION_ADDRESS: sponsored.accountImplementation,
            BUNDLER_URL: sponsored.bundlerUrl
        })
        if (!delivery?.sponsored) throw new Error("expected loadConfig to populate delivery.sponsored")

        const ports = await buildSponsoredDeliveryPorts(delivery, RPC_URL, approval)

        assert.ok(ports.submitter instanceof SponsoredAnnouncementSubmitter)
        assert.equal(ports.submitter.announcerAddress.toLowerCase(), config.announcerAddress.toLowerCase())
    } finally {
        rpc.restore()
    }
})
