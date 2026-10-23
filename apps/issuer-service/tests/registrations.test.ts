import assert from "node:assert/strict"
import { after, afterEach, before, mock, test } from "node:test"
import { format } from "node:util"
import { getCurveFromName, type Curve } from "ffjavascript"
import { BaseError, ContractFunctionExecutionError, parseAbi } from "viem"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { NetworkMemberClientError } from "@coordination-network/network-member-client"
import type {
    IdentityReader,
    RegistrationProver,
    RegistrationWrite,
    RegistrationWriter,
    SubmitRegistrationPorts
} from "@coordination-network/network-member-client"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import { buildRegistrationRequest, onboard } from "@coordination-network/user-client"
import type { ChainDomain, Hex } from "@coordination-network/user-client"
import { ActivityLog } from "../src/activity"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"ee".repeat(32)}` as Hex32
const DEVICE_SECRET: Hex = `0x${"13".repeat(32)}`
const DOMAIN: ChainDomain = { chainId: 31337, verifyingContract: `0x${"aa".repeat(20)}` as Hex }
const REGISTRY: RegistryLocation = { chainId: BigInt(DOMAIN.chainId), address: DOMAIN.verifyingContract }
const FIXED_PROOF: NetworkMemberProof = {
    merkleTreeDepth: 1n,
    merkleTreeRoot: 0n,
    nullifier: 0n,
    scope: 0n,
    points: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]
}

function fakeRegistrationPorts(registerIdentity: RegistrationWriter["registerIdentity"]): SubmitRegistrationPorts {
    const identityReader: IdentityReader = { getIdentity: async () => null }
    const prover: RegistrationProver = { registry: REGISTRY, prove: async () => FIXED_PROOF }
    const writer: RegistrationWriter = { registry: REGISTRY, registerIdentity }
    return { domain: DOMAIN, identityReader, prover, writer }
}

function viemCallError(networkId: Hex, metaStealthAddress: Hex): ContractFunctionExecutionError {
    return new ContractFunctionExecutionError(new BaseError("rpc timed out"), {
        abi: parseAbi(["function registerIdentity(bytes32 networkId, bytes metaStealthAddress)"]),
        args: [networkId, metaStealthAddress],
        functionName: "registerIdentity",
        contractAddress: REGISTRY.address
    })
}

/** What console printed: `format` expands an Error's `[cause]`, which `String` would not. */
function printed(calls: readonly { arguments: readonly unknown[] }[]): string {
    return calls.map((call) => format(...call.arguments)).join("\n")
}

function assertNoCallData(output: string, networkId: string): void {
    assert.equal(output.toLowerCase().includes(networkId.toLowerCase()), false)
    assert.equal(output.includes("Contract Call"), false)
}

async function post(
    registration: SubmitRegistrationPorts,
    body: unknown,
    activityLog = new ActivityLog()
): Promise<Response> {
    const signer = new LocalCredentialSigner("issuer-service-registrations-unit")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, registration, activityLog })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        return await fetch(`http://127.0.0.1:${port}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    } finally {
        listener.close()
    }
}

test("201s with the sponsorship's bigints as decimal strings when the writer sponsored the write", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const write: RegistrationWrite = {
        txHash: "0xbundletxhash",
        sponsorship: {
            sender: `0x${"11".repeat(20)}` as Hex,
            senderBalanceBefore: 0n,
            senderBalanceAfter: 0n,
            userOpHash: `0x${"22".repeat(32)}` as Hex,
            bundleTxHash: "0xbundletxhash",
            actualGasCost: 123456789012345n,
            paymaster: `0x${"33".repeat(20)}` as Hex,
            paymasterDepositBefore: 1_000_000_000_000_000_000n,
            paymasterDepositAfter: 999_876_543_210_000_000n
        }
    }
    const registration = fakeRegistrationPorts(async () => write)
    const activityLog = new ActivityLog()

    const res = await post(registration, request, activityLog)

    assert.equal(res.status, 201)
    // No refs: the sender and userOpHash resolve in one eth_getLogs to the bundle transaction's
    // IdentityRegistered log, which would link this member to the network id it just relayed for.
    assert.deepEqual(
        activityLog.recent().map(({ kind, message, refs }) => ({ kind, message, refs })),
        [
            {
                kind: "registration",
                message: "registered a network id, gas paid by the paymaster",
                refs: undefined
            }
        ]
    )
    assert.deepEqual(await res.json(), {
        status: "submitted",
        txHash: "0xbundletxhash",
        sponsorship: {
            sender: write.sponsorship?.sender,
            senderBalanceBefore: "0",
            senderBalanceAfter: "0",
            userOpHash: write.sponsorship?.userOpHash,
            bundleTxHash: "0xbundletxhash",
            actualGasCost: "123456789012345",
            paymaster: write.sponsorship?.paymaster,
            paymasterDepositBefore: "1000000000000000000",
            paymasterDepositAfter: "999876543210000000"
        }
    })
})

test("201s with no sponsorship field when the writer did not sponsor the write", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const registration = fakeRegistrationPorts(async () => ({ txHash: "0xplaintxhash" }))

    const res = await post(registration, request)

    assert.equal(res.status, 201)
    assert.deepEqual(await res.json(), { status: "submitted", txHash: "0xplaintxhash" })
})

test("200s and tags the activity entry 'existing' when the identity is already registered", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const identityReader: IdentityReader = { getIdentity: async () => request.metaStealthAddress }
    const prover: RegistrationProver = { registry: REGISTRY, prove: async () => FIXED_PROOF }
    const writer: RegistrationWriter = {
        registry: REGISTRY,
        registerIdentity: async () => {
            throw new Error("registerIdentity should not be reached: already registered")
        }
    }
    const registration: SubmitRegistrationPorts = { domain: DOMAIN, identityReader, prover, writer }
    const activityLog = new ActivityLog()

    const res = await post(registration, request, activityLog)

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
        status: "alreadyRegistered",
        metaStealthAddress: request.metaStealthAddress,
        matchesRequest: true
    })
    assert.deepEqual(
        activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
        [{ kind: "registration", message: "found an existing registration", outcome: "existing" }]
    )
})

test("503s and tags the activity entry 'failed' when the writer's registry is unavailable", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const registration = fakeRegistrationPorts(async () => {
        throw new Error("rpc timed out")
    })
    const activityLog = new ActivityLog()

    const res = await post(registration, request, activityLog)

    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { error: "registry unavailable", code: "REGISTRY_UNAVAILABLE" })
    assert.deepEqual(
        activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
        [{ kind: "registration", message: "registration failed: REGISTRY_UNAVAILABLE", outcome: "failed" }]
    )
})

test("503s with the group-mirror message and tags the activity entry 'failed' when the prover can't reach the mirror", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const identityReader: IdentityReader = { getIdentity: async () => null }
    const prover: RegistrationProver = {
        registry: REGISTRY,
        prove: async () => {
            throw new NetworkMemberClientError("GROUP_MIRROR_UNAVAILABLE", "mirror unreachable")
        }
    }
    const writer: RegistrationWriter = {
        registry: REGISTRY,
        registerIdentity: async () => {
            throw new Error("registerIdentity should not be reached: proving fails first")
        }
    }
    const registration: SubmitRegistrationPorts = { domain: DOMAIN, identityReader, prover, writer }
    const activityLog = new ActivityLog()

    const res = await post(registration, request, activityLog)

    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { error: "registration group unavailable", code: "GROUP_MIRROR_UNAVAILABLE" })
    assert.deepEqual(
        activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
        [{ kind: "registration", message: "registration failed: GROUP_MIRROR_UNAVAILABLE", outcome: "failed" }]
    )
})

test("400s and logs only the code, never the networkId, when the request fails verification", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const tampered = { ...request, signature: `0x${"00".repeat(65)}` as Hex }
    const warn = mock.method(console, "warn", () => {})
    const registration = fakeRegistrationPorts(async () => {
        throw new Error("registerIdentity should not be reached: request fails verification")
    })

    const res = await post(registration, tampered)

    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
        error: "invalid registration request",
        code: "INVALID_REGISTRATION_REQUEST"
    })
    const output = printed(warn.mock.calls)
    assert.ok(output.includes("INVALID_REGISTRATION_REQUEST"))
    assertNoCallData(output, request.networkId)
})

test("503s and logs the code with a sanitized cause, never the networkId, when the writer's call fails", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const warn = mock.method(console, "warn", () => {})
    const registration = fakeRegistrationPorts(async () => {
        throw viemCallError(request.networkId, request.metaStealthAddress)
    })

    const res = await post(registration, request)

    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { error: "registry unavailable", code: "REGISTRY_UNAVAILABLE" })
    const output = printed(warn.mock.calls)
    assert.ok(output.includes("REGISTRY_UNAVAILABLE"))
    assert.ok(output.includes("registration submission failed"))
    assertNoCallData(output, request.networkId)
})

test("500s and logs a sanitized cause to console.error, never the networkId, when the prover throws unwrapped", async () => {
    const request = buildRegistrationRequest(onboard(DEVICE_SECRET).keys, DOMAIN)
    const errorLog = mock.method(console, "error", () => {})
    const identityReader: IdentityReader = { getIdentity: async () => null }
    const prover: RegistrationProver = {
        registry: REGISTRY,
        prove: async () => {
            throw viemCallError(request.networkId, request.metaStealthAddress)
        }
    }
    const writer: RegistrationWriter = {
        registry: REGISTRY,
        registerIdentity: async () => {
            throw new Error("registerIdentity should not be reached: proving fails first")
        }
    }
    const registration: SubmitRegistrationPorts = { domain: DOMAIN, identityReader, prover, writer }

    const res = await post(registration, request)

    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: "internal error" })
    const output = printed(errorLog.mock.calls)
    assert.ok(output.startsWith("ContractFunctionExecutionError: rpc timed out\n    at "))
    assertNoCallData(output, request.networkId)
})

afterEach(() => {
    mock.restoreAll()
})

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

before(async () => {
    curve = await getCurveFromName("bn128")
})

after(async () => {
    await curve.terminate()
})
