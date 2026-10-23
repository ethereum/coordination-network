import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { getCurveFromName, type Curve } from "ffjavascript"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import type { DeliverToStealthPorts } from "@coordination-network/network-member-client"
import { onboard } from "@coordination-network/user-client"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"dd".repeat(32)}` as Hex32
const DEVICE_SECRET = `0x${"12".repeat(32)}` as const
const TOKEN = "a-member-server-token-long-enough"

function fakeDeliveryPorts(overrides: Partial<DeliverToStealthPorts> = {}): DeliverToStealthPorts {
    return {
        approval: { isApprovedNetworkMember: async () => true },
        identityReader: { getIdentity: async () => onboard(DEVICE_SECRET).metaStealthAddress },
        submitter: { announce: async () => `0x${"aa".repeat(32)}` as `0x${string}` },
        ...overrides
    }
}

async function post(
    delivery: DeliverToStealthPorts | undefined,
    body: unknown,
    opts: { memberServerToken?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
    const signer = new LocalCredentialSigner("issuer-service-deliveries-unit")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        delivery,
        memberServerToken: opts.memberServerToken
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    try {
        return await fetch(`http://127.0.0.1:${port}/v1/deliveries`, {
            method: "POST",
            headers: { "content-type": "application/json", ...opts.headers },
            body: JSON.stringify(body)
        })
    } finally {
        listener.close()
    }
}

test("401 UNAUTHORIZED with no token, once one is configured", async () => {
    const delivery = fakeDeliveryPorts()

    const res = await post(delivery, { networkId: onboard(DEVICE_SECRET).networkId }, { memberServerToken: TOKEN })

    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: "member server token required", code: "UNAUTHORIZED" })
})

test("401 UNAUTHORIZED with the wrong token", async () => {
    const delivery = fakeDeliveryPorts()

    const res = await post(
        delivery,
        { networkId: onboard(DEVICE_SECRET).networkId },
        {
            memberServerToken: TOKEN,
            headers: { authorization: "Bearer not-the-token" }
        }
    )

    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: "member server token required", code: "UNAUTHORIZED" })
})

test("201 with exactly {status, txHash}, dropping the stealth address", async () => {
    const delivery = fakeDeliveryPorts()

    const res = await post(
        delivery,
        { networkId: onboard(DEVICE_SECRET).networkId },
        {
            memberServerToken: TOKEN,
            headers: { authorization: `Bearer ${TOKEN}` }
        }
    )

    assert.equal(res.status, 201)
    assert.deepEqual(await res.json(), { status: "announced", txHash: `0x${"aa".repeat(32)}` })
})

test("422 DELIVERY_REFUSED for an unregistered recipient", async () => {
    const networkId = onboard(DEVICE_SECRET).networkId
    const delivery = fakeDeliveryPorts({ identityReader: { getIdentity: async () => null } })

    const res = await post(delivery, { networkId })

    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { error: "delivery refused", code: "DELIVERY_REFUSED" })
})

test("422 DELIVERY_REFUSED for a malformed registered meta-address, same body as an unregistered recipient", async () => {
    const networkId = onboard(DEVICE_SECRET).networkId
    const delivery = fakeDeliveryPorts({ identityReader: { getIdentity: async () => "0xnotavalidmetastealthaddress" } })

    const res = await post(delivery, { networkId })

    assert.equal(res.status, 422)
    assert.deepEqual(await res.json(), { error: "delivery refused", code: "DELIVERY_REFUSED" })
})

test("401 UNAUTHORIZED beats 503 NOT_CONFIGURED: the guard runs even with no delivery ports mounted", async () => {
    const res = await post(undefined, { networkId: onboard(DEVICE_SECRET).networkId }, { memberServerToken: TOKEN })

    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: "member server token required", code: "UNAUTHORIZED" })
})

test("401 UNAUTHORIZED beats 400: the guard runs before the body is even parsed", async () => {
    const delivery = fakeDeliveryPorts()

    const res = await post(delivery, { networkId: "not-a-hex32" }, { memberServerToken: TOKEN })

    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: "member server token required", code: "UNAUTHORIZED" })
})

test("a 401 never reaches the delivery ports: the guard runs before any of them are touched", async () => {
    let approvalCalls = 0
    let announceCalls = 0
    const delivery = fakeDeliveryPorts({
        approval: {
            isApprovedNetworkMember: async () => {
                approvalCalls++
                return true
            }
        },
        submitter: {
            announce: async () => {
                announceCalls++
                return `0x${"aa".repeat(32)}` as `0x${string}`
            }
        }
    })

    const res = await post(delivery, { networkId: onboard(DEVICE_SECRET).networkId }, { memberServerToken: TOKEN })

    assert.equal(res.status, 401)
    assert.equal(approvalCalls, 0)
    assert.equal(announceCalls, 0)
})

test("no delivery error body carries the request's networkId, whichever status answers", async () => {
    const networkId = onboard(DEVICE_SECRET).networkId
    const scenarios: [
        number,
        DeliverToStealthPorts,
        { memberServerToken?: string; headers?: Record<string, string> }?
    ][] = [
        [401, fakeDeliveryPorts(), { memberServerToken: TOKEN }],
        [403, fakeDeliveryPorts({ approval: { isApprovedNetworkMember: async () => false } })],
        [422, fakeDeliveryPorts({ identityReader: { getIdentity: async () => null } })],
        [
            502,
            fakeDeliveryPorts({
                submitter: {
                    announce: async () => {
                        throw new Error(`submission rejected for ${networkId}`)
                    }
                }
            })
        ]
    ]

    for (const [status, delivery, opts] of scenarios) {
        const res = await post(delivery, { networkId }, opts)
        const text = await res.text()
        assert.equal(res.status, status)
        assert.equal(text.toLowerCase().includes(networkId.toLowerCase()), false, `${status}: ${text}`)
    }
})

test("403 MEMBER_NOT_APPROVED when the approval resolver returns false", async () => {
    const delivery = fakeDeliveryPorts({ approval: { isApprovedNetworkMember: async () => false } })

    const res = await post(delivery, { networkId: onboard(DEVICE_SECRET).networkId })

    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { code: string }).code, "MEMBER_NOT_APPROVED")
})

test("502 ANNOUNCE_FAILED when the submitter throws, without leaking the error or the networkId", async () => {
    const networkId = onboard(DEVICE_SECRET).networkId
    const delivery = fakeDeliveryPorts({
        submitter: {
            announce: async () => {
                throw new Error(`submission rejected for ${networkId}`)
            }
        }
    })

    const res = await post(delivery, { networkId })

    assert.equal(res.status, 502)
    const body = await res.json()
    assert.deepEqual(body, { error: "announce failed", code: "ANNOUNCE_FAILED" })
    assert.equal(JSON.stringify(body).includes(networkId), false)
})

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

before(async () => {
    curve = await getCurveFromName("bn128")
})

after(async () => {
    await curve.terminate()
})
