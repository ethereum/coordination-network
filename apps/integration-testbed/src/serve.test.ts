import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, randomBytes } from "@noble/hashes/utils"
import { getAddress, keccak256, toBytes } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { buildServer } from "../../issuer-service/src/server"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import { OperatorError } from "./operator-error"
import { NETWORK_MEMBER_PUBLIC_KEY, personas } from "./personas"
import {
    admissionPlan,
    admissionSeatShortfall,
    Brand,
    buildMember,
    buildMembers,
    buildStackDescriptor,
    createFatalHandler,
    lanAddress,
    Member,
    MEMBER_PROFILES,
    memberSecrets,
    pollUntil,
    portFromEnvironment,
    readJson,
    rootMovedFrom,
    runOnce,
    StackAddresses,
    webDemoOrigins
} from "./serve"

test("web demo CORS permits the member status page's own POSTs and still refuses other origins", async (t) => {
    const server = createServer()
    t.after(() => {
        server.close()
        server.closeAllConnections()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    server.on(
        "request",
        buildServer({
            issuerNetworkId: `0x${"aa".repeat(32)}`,
            signer: new LocalCredentialSigner("status-page-cors"),
            resolver: new InMemoryResolver(),
            allowedOrigins: webDemoOrigins("127.0.0.1", port)
        })
    )
    for (const origin of [base, `http://localhost:${port}`, "http://localhost:4173"]) {
        const response = await fetch(`${base}/v1/presentation-requests`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ programme: "demo-programme", country: "ZZZ" })
        })
        assert.equal(response.status, 201, `${origin} must be able to POST`)
        assert.equal(response.headers.get("access-control-allow-origin"), origin)
    }
    const foreign = await fetch(`${base}/v1/presentation-requests`, {
        method: "POST",
        headers: { origin: "http://other.example", "content-type": "application/json" },
        body: JSON.stringify({ programme: "demo-programme", country: "ZZZ" })
    })
    assert.equal(foreign.status, 403)
})

const TEST_BRAND: Brand = { accent: "#1d4ed8", onAccent: "#ffffff", accentSoft: "#dde6fb", accentInk: "#1d4ed8" }

const CHAIN = { rpcUrl: "http://127.0.0.1:8545", chainId: 1337 }

const ADDRESSES: StackAddresses = {
    identityRegistry: "0x1000000000000000000000000000000000000001",
    announcer: "0x1000000000000000000000000000000000000002",
    revocation: "0x1000000000000000000000000000000000000003",
    credentialRevocationRegistry: "0x100000000000000000000000000000000000000d",
    credentialRevocationRegistryId: 1n,
    semaphore: "0x1000000000000000000000000000000000000004",
    networkMemberRegistry: "0x1000000000000000000000000000000000000005",
    networkMemberGroup: "0x1000000000000000000000000000000000000006",
    networkMemberGovernance: "0x1000000000000000000000000000000000000007",
    approvedIssuerSet: "0x1000000000000000000000000000000000000008",
    governanceSafe: "0x1000000000000000000000000000000000000009",
    entryPoint: "0x100000000000000000000000000000000000000a",
    paymaster: "0x100000000000000000000000000000000000000b",
    accountImplementation: "0x100000000000000000000000000000000000000c"
}

function testMember(name: string, role: "founder" | "candidate"): Member {
    return buildMember(
        name,
        randomBytes(32),
        role,
        new LocalCredentialSigner(`test-${name}`),
        generatePrivateKey(),
        generatePrivateKey(),
        3001,
        TEST_BRAND
    )
}

test("buildMember's networkId is the plain hash of the account public key", () => {
    const member = testMember("alpha", "founder")
    const coordinates = secp256k1.getPublicKey(member.authPrivateKey.slice(2), false).slice(1)

    assert.equal(member.networkId, `0x${bytesToHex(keccak_256(coordinates))}`)
})

test("buildMember derives an auth address equal to networkId's low 20 bytes", () => {
    const member = testMember("alpha", "founder")
    const lowTwentyBytes = `0x${member.networkId.slice(-40)}`

    assert.equal(member.authAddress.toLowerCase(), lowTwentyBytes.toLowerCase())
})

test("every testbed member's networkId is the id the registry derives from its auth key", () => {
    for (const profile of MEMBER_PROFILES) {
        const member = testMember(profile.name, profile.role)
        const { memberNetworkId } = memberAccountKey(privateKeyToAccount(member.authPrivateKey).publicKey)

        assert.equal(memberNetworkId, member.networkId, profile.name)
    }
})

test("the Network Member persona's public key is the documented point on the curve", () => {
    const P = 2n ** 256n - 2n ** 32n - 977n
    const modPow = (base: bigint, exponent: bigint): bigint => {
        let result = 1n
        for (let b = base % P, e = exponent; e > 0n; e >>= 1n, b = (b * b) % P) {
            if (e & 1n) result = (result * b) % P
        }
        return result
    }
    let x = BigInt(keccak256(toBytes("coordination-network/testbed/network-member"))) % P
    while (modPow(x ** 3n + 7n, (P - 1n) / 2n) !== 1n) x++
    const root = modPow(x ** 3n + 7n, (P + 1n) / 4n)
    const y = root % 2n === 0n ? root : P - root
    const derived = `0x${x.toString(16).padStart(64, "0")}${y.toString(16).padStart(64, "0")}`

    assert.equal(NETWORK_MEMBER_PUBLIC_KEY, derived)
    secp256k1.ProjectivePoint.fromHex(`04${derived.slice(2)}`).assertValidity()
})

test("the Network Member persona's networkId is the id of its public key", () => {
    assert.equal(personas.networkMember.networkId, keccak256(NETWORK_MEMBER_PUBLIC_KEY))
})

test("buildMember never lets the governance signer coincide with the auth address", () => {
    const member = testMember("alpha", "founder")

    assert.notEqual(member.governanceSignerAddress.toLowerCase(), member.authAddress.toLowerCase())
})

test("buildMember assigns the role it is given, independent of any other member", () => {
    const founder = testMember("alpha", "founder")
    const candidate = testMember("beta", "candidate")

    assert.equal(founder.role, "founder")
    assert.equal(candidate.role, "candidate")
})

test("buildMember derives the governance signer address from its own private key", () => {
    const governanceSignerPrivateKey = generatePrivateKey()
    const member = buildMember(
        "alpha",
        randomBytes(32),
        "founder",
        new LocalCredentialSigner("test-alpha"),
        generatePrivateKey(),
        governanceSignerPrivateKey,
        3001,
        TEST_BRAND
    )

    assert.equal(member.governanceSignerAddress, privateKeyToAccount(governanceSignerPrivateKey).address)
})

test("buildStackDescriptor carries every new top-level address and URL field", () => {
    const stack = buildStackDescriptor("127.0.0.1", CHAIN, ADDRESSES, [])

    assert.equal(stack.semaphore, ADDRESSES.semaphore)
    assert.equal(stack.networkMemberRegistry, ADDRESSES.networkMemberRegistry)
    assert.equal(stack.networkMemberGroup, ADDRESSES.networkMemberGroup)
    assert.equal(stack.networkMemberGovernance, ADDRESSES.networkMemberGovernance)
    assert.equal(stack.approvedIssuerSet, ADDRESSES.approvedIssuerSet)
    assert.equal(stack.governanceSafe, ADDRESSES.governanceSafe)
    assert.equal(stack.entryPoint, ADDRESSES.entryPoint)
    assert.equal(stack.paymaster, ADDRESSES.paymaster)
    assert.equal(stack.accountImplementation, ADDRESSES.accountImplementation)
    assert.equal(stack.bundlerUrl, "http://127.0.0.1:4337")
    assert.equal(stack.dashboardUrl, "http://127.0.0.1:8080")
})

test("buildStackDescriptor takes the RPC URL and chain id it is given", () => {
    const stack = buildStackDescriptor("127.0.0.1", { rpcUrl: "https://rpc.example", chainId: 11155111 }, ADDRESSES, [])

    assert.equal(stack.rpcUrl, "https://rpc.example")
    assert.equal(stack.chainId, 11155111)
})

test("buildStackDescriptor shapes each member's role, auth address, and governance signer", () => {
    const founder = testMember("alpha", "founder")
    const candidate = testMember("beta", "candidate")

    const stack = buildStackDescriptor("127.0.0.1", CHAIN, ADDRESSES, [founder, candidate])

    assert.equal(stack.members.length, 2)
    assert.deepEqual(
        stack.members.map((member) => member.role),
        ["founder", "candidate"]
    )
    assert.equal(stack.members[0].authAddress, founder.authAddress)
    assert.equal(stack.members[0].governanceSigner, founder.governanceSignerAddress)
    // One registry for the network, named once at the top level rather than per member.
    assert.equal(stack.revocation.registry, ADDRESSES.credentialRevocationRegistry)
    assert.equal(stack.revocation.registryId, "1")
})

test("buildStackDescriptor carries no member server token, on any member", () => {
    const founder = testMember("alpha", "founder")
    const candidate = testMember("beta", "candidate")

    const stack = buildStackDescriptor("127.0.0.1", CHAIN, ADDRESSES, [founder, candidate])
    const json = JSON.stringify(stack)

    for (const member of stack.members) assert.equal("memberServerToken" in member, false)
    assert.equal(json.includes(founder.memberServerToken), false)
    assert.equal(json.includes(candidate.memberServerToken), false)
})

test("buildStackDescriptor copies each member's brand, and its scheme when it has one", () => {
    const withScheme = buildMember(
        "alpha",
        randomBytes(32),
        "founder",
        new LocalCredentialSigner("test-alpha"),
        generatePrivateKey(),
        generatePrivateKey(),
        3001,
        TEST_BRAND,
        "member-a"
    )
    const withoutScheme = testMember("gamma", "candidate")

    const stack = buildStackDescriptor("127.0.0.1", CHAIN, ADDRESSES, [withScheme, withoutScheme])

    assert.deepEqual(stack.members[0].brand, TEST_BRAND)
    assert.equal(stack.members[0].scheme, "member-a")
    assert.deepEqual(stack.members[1].brand, TEST_BRAND)
    assert.equal(stack.members[1].scheme, undefined)
})

test("every member profile carries a brand of four valid 6-digit hex colours", () => {
    const hex6 = /^#[0-9a-f]{6}$/i
    for (const profile of MEMBER_PROFILES) {
        for (const [field, value] of Object.entries(profile.brand)) {
            assert.match(value, hex6, `${profile.name}.brand.${field} is not a 6-digit hex colour: ${value}`)
        }
    }
})

test("fixed seeds derive the same ids, keys and addresses they always have", async () => {
    const members = buildMembers(
        [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte)),
        31337
    )

    assert.deepEqual(
        await Promise.all(
            members.map(async (member) => ({
                name: member.name,
                networkId: member.networkId,
                authAddress: member.authAddress,
                governanceSignerAddress: member.governanceSignerAddress,
                walletAddress: privateKeyToAccount(member.walletPrivateKey).address,
                publicKey: (await member.signer.getPublicKey()).map(String),
                semaphoreCommitment: String(member.semaphoreCommitment),
                metaStealthAddress: member.metaStealthAddress
            }))
        ),
        [
            {
                name: "Member A",
                networkId: "0x97f9db96712d3fc387508e18e467a214701b453614aa9998600c5936fbb0b9cf",
                authAddress: "0xE467a214701b453614aa9998600C5936Fbb0B9CF",
                governanceSignerAddress: "0x129B5198C493b2Bf5b0BcD3F0523730E6cc21464",
                walletAddress: "0xDd623D56Be713D21A01E8F1DA1E72Bb9033A86AA",
                publicKey: [
                    "20672142526364618278678053927343621789933290281809595058002199314906386328350",
                    "18102835784396189841277800494691221395562657193840751629959585245330104061223"
                ],
                semaphoreCommitment: "13077993975812165370966885403993971692250188476543979671127900155912791347982",
                metaStealthAddress:
                    "0x02a0c317561acbcb4b7990f8d892814db4c97a16d1fc2191cd2a7064c28b5f4bef03f745cafa1e8be0ef8db522689511261e635f4735d0188ae0cd94792c5bc7b619"
            },
            {
                name: "Member B",
                networkId: "0xf9823d6ca4ed32ce99858796dc0b70e43bc6c0d0db7fca9ab36f327ca55f29e5",
                authAddress: "0xDc0b70E43bc6c0D0DB7Fca9AB36f327Ca55f29E5",
                governanceSignerAddress: "0x4fEe95b3aDf85544C1aDCb99E484bF1B3B41Fc2F",
                walletAddress: "0xe5fDbF4158b8A54a2148972F54d4A10D3e457CA0",
                publicKey: [
                    "2237870987458175147806655458864847091311875093989975393529787754062781904152",
                    "14696621500892195609752712657967067047824121645773390534646722235038400379279"
                ],
                semaphoreCommitment: "1623878171162583655413791332437311425750514553518641368880166214603756207045",
                metaStealthAddress:
                    "0x02528ae5a89e3b2720734701647f7a7d1d713d73797a025b32b19be3f4e1440aab02b5dae4efd1f02c7e42c471b004a2bebf681500de16a92bd55541ab0dad546523"
            },
            {
                name: "Member C",
                networkId: "0x4d72ecc989fff4c077f0896883d24018cc9a0c2ef61b9a6196075f690716215d",
                authAddress: "0x83d24018Cc9A0C2ef61b9a6196075F690716215D",
                governanceSignerAddress: "0x0034526de3A8f793B94942eC142155B6640AeE34",
                walletAddress: "0x425F57CFdddf6D9AC25D2C08D78a308AD93F827a",
                publicKey: [
                    "11877015312387180004190384794766755274147251888641358921674115453543735527148",
                    "20163746086441395784262148610914320899736428448931881647751096688941111571681"
                ],
                semaphoreCommitment: "16174229374558414938032948943992723392793391478740518529524463024839121948474",
                metaStealthAddress:
                    "0x022ffa5df8d6429c580ce81edbe0b06476cafe03cf8998049138d3f202e82f713c02a8125c13057e63baabb8531d1de4da6d2b9e727a812d63a5365be62094a1a239"
            }
        ]
    )
})

test("fixed seeds derive the same credential keys on Sepolia they always have", async () => {
    const members = buildMembers(
        [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte)),
        11155111
    )

    assert.deepEqual(
        await Promise.all(members.map(async (member) => (await member.signer.getPublicKey()).map(String))),
        [
            [
                "4136272185756610862088599013956535935799855791770722319120119383857812235758",
                "17352633468368516047589986966522070295631803988703331985004337734076869867089"
            ],
            [
                "19500259541787660398804181977521799912416392464291261864301437233803601038580",
                "9969272482159564013375152578828881940956400791807398592794198802833335198780"
            ],
            [
                "11695867956751174739367247857709661781130739546491267192908255443053256626704",
                "21783631923722165241539626522514090713588642217744069605945178968103493364887"
            ]
        ]
    )
})

function withMemberSeeds<T>(value: string, run: () => T): T {
    const previous = process.env.STACK_MEMBER_SEEDS
    process.env.STACK_MEMBER_SEEDS = value
    try {
        return run()
    } finally {
        if (previous === undefined) delete process.env.STACK_MEMBER_SEEDS
        else process.env.STACK_MEMBER_SEEDS = previous
    }
}

const SEED_A = "11".repeat(32)
const SEED_B = "22".repeat(32)
const SEED_C = "33".repeat(32)

test("memberSecrets reads three distinct 32-byte seeds, with or without 0x", () => {
    const secrets = withMemberSeeds(`0x${SEED_A}, ${SEED_B},${SEED_C}`, memberSecrets)

    assert.deepEqual(
        secrets.map((secret) => bytesToHex(secret)),
        [SEED_A, SEED_B, SEED_C]
    )
})

test("memberSecrets refuses a malformed or miscounted seed list, naming the variable", () => {
    for (const value of [`${SEED_A},${SEED_B}`, `${SEED_A},${SEED_B},zz`, `${SEED_A},${SEED_B},${SEED_C.slice(2)}`]) {
        assert.throws(
            () => withMemberSeeds(value, memberSecrets),
            (error) => error instanceof OperatorError && /STACK_MEMBER_SEEDS must be exactly three/.test(error.message),
            value
        )
    }
})

test("memberSecrets refuses a repeated seed, which would make the orgs one identity", () => {
    assert.throws(
        () => withMemberSeeds(`${SEED_A},${SEED_B},${SEED_A.toUpperCase()}`, memberSecrets),
        (error) =>
            error instanceof OperatorError && /STACK_MEMBER_SEEDS must be three distinct seeds/.test(error.message)
    )
})

test("a blank STACK_MEMBER_SEEDS is unset, so a local run draws random seeds", () => {
    assert.equal(withMemberSeeds("  ", memberSecrets).length, 3)
})

test("runOnce runs its task once, and a second caller waits for the run in flight", async () => {
    let runs = 0
    let finished = false
    const stop = runOnce(async () => {
        runs += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        finished = true
    })

    const first = stop()
    await stop()

    assert.equal(finished, true)
    assert.equal(runs, 1)
    await first
})

test("a blank port setting is the default, not port 0 or NaN", () => {
    process.env.TEST_BLANK_PORT = ""
    try {
        assert.equal(portFromEnvironment("TEST_BLANK_PORT", 4337), 4337)
        process.env.TEST_BLANK_PORT = "9000"
        assert.equal(portFromEnvironment("TEST_BLANK_PORT", 4337), 9000)
    } finally {
        delete process.env.TEST_BLANK_PORT
    }
})

test("a blank STACK_HOST in testnet mode is loopback, never an empty host that binds every interface", () => {
    const saved = [process.env.TESTBED_MODE, process.env.STACK_HOST]
    process.env.TESTBED_MODE = "testnet"
    process.env.STACK_HOST = ""
    try {
        assert.equal(lanAddress(), "127.0.0.1")
    } finally {
        for (const [key, value] of [
            ["TESTBED_MODE", saved[0]],
            ["STACK_HOST", saved[1]]
        ] as const) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
})

test("the fatal handler prints the redacted stack, stops what runs, and exits 1 once", async () => {
    const written: string[] = []
    const exits: number[] = []
    let stops = 0
    const fatal = createFatalHandler({
        cleanup: async () => {
            stops += 1
        },
        write: (text) => written.push(text),
        exit: (code) => exits.push(code)
    })
    const error = new Error("HTTP request failed. URL: https://eth-sepolia.example.io/v2/SECRETKEY")

    await fatal("unhandledRejection", error)
    await fatal("uncaughtException", error)

    assert.equal(written.length, 1)
    assert.match(written[0], /^unhandledRejection: Error: HTTP request failed/)
    assert.ok(written[0].includes("at "), "the stack is printed")
    assert.ok(!written[0].includes("SECRETKEY"))
    assert.equal(stops, 1)
    assert.deepEqual(exits, [1])
})

test("the fatal handler prints an operator error as its message alone, without a stack", async () => {
    const written: string[] = []
    const fatal = createFatalHandler({ cleanup: async () => {}, write: (text) => written.push(text), exit: () => {} })

    await fatal("uncaughtException", new OperatorError("RPC_URL must be set to run against a public network"))

    assert.deepEqual(written, ["uncaughtException: RPC_URL must be set to run against a public network\n"])
})

test("the fatal handler still exits when stopping throws", async () => {
    const exits: number[] = []
    const fatal = createFatalHandler({
        cleanup: async () => {
            throw new Error("already stopped")
        },
        write: () => {},
        exit: (code) => exits.push(code)
    })

    await fatal("uncaughtException", new Error("boom"))

    assert.deepEqual(exits, [1])
})

test("admissionPlan always plays the story on a local chain, which is rebuilt each run", () => {
    assert.deepEqual(
        admissionPlan({ testnet: false, requested: false, candidateApproved: false, requestPending: false }),
        { run: true, resumeAtApprovals: false }
    )
})

test("admissionPlan leaves a deployed network alone unless the story is asked for", () => {
    const plan = admissionPlan({ testnet: true, requested: false, candidateApproved: false, requestPending: false })

    assert.equal(plan.run, false)
    assert.match("reason" in plan ? plan.reason : "", /--check-admission/)
})

test("admissionPlan skips a candidate a deployed network has already admitted", () => {
    const plan = admissionPlan({ testnet: true, requested: true, candidateApproved: true, requestPending: true })

    assert.equal(plan.run, false)
    assert.match("reason" in plan ? plan.reason : "", /already approved.*once per deployment/)
})

test("admissionPlan plays the story on a deployed network when asked and the candidate is outside", () => {
    assert.deepEqual(
        admissionPlan({ testnet: true, requested: true, candidateApproved: false, requestPending: false }),
        { run: true, resumeAtApprovals: false }
    )
})

test("admissionPlan resumes at the approvals when the candidate's request is already on chain", () => {
    assert.deepEqual(
        admissionPlan({ testnet: true, requested: true, candidateApproved: false, requestPending: true }),
        {
            run: true,
            resumeAtApprovals: true
        }
    )
})

test("admissionPlan does not resume on a local chain, which has no earlier run", () => {
    assert.deepEqual(
        admissionPlan({ testnet: false, requested: false, candidateApproved: false, requestPending: true }),
        {
            run: true,
            resumeAtApprovals: false
        }
    )
})

test("admissionSeatShortfall names the founders' seats against the threshold, and is silent when they reach it", () => {
    const [first, second, other] = [1, 2, 3].map((index) => getAddress(`0x${index.toString().repeat(40)}`))

    assert.equal(admissionSeatShortfall([first, second], [other, first, second], 2), undefined)
    assert.match(
        admissionSeatShortfall([first, second], [other, other, first, second], 4) ?? "",
        /the founders own 2 of the 4 approvals the Safe needs/
    )
    assert.match(admissionSeatShortfall([first, first], [first, other], 2) ?? "", /own 1 of the 2/)
})

test("pollUntil keeps reading until the value is ready, and returns it", async () => {
    let calls = 0

    const value = await pollUntil(
        async () => (calls += 1),
        (count) => count === 3,
        1000,
        1
    )

    assert.equal(value, 3)
    assert.equal(calls, 3)
})

test("pollUntil gives up with the last value once the timeout passes", async () => {
    await assert.rejects(
        pollUntil(
            async () => 0,
            (count) => count === 1,
            20,
            5
        ),
        /not met within 20ms \(last value: 0\)/
    )
})

test("pollUntil keeps polling through a read that throws, then returns once one succeeds", async () => {
    let calls = 0

    const value = await pollUntil(
        async () => {
            calls += 1
            if (calls <= 2) throw new Error("status page answered 503")
            return "up"
        },
        (answer) => answer === "up",
        1000,
        1
    )

    assert.equal(value, "up")
    assert.equal(calls, 3)
})

test("pollUntil rethrows the last error when every read threw until the timeout", async () => {
    let calls = 0

    await assert.rejects(
        pollUntil(
            async () => {
                calls += 1
                throw new Error(`429 on call ${calls}`)
            },
            () => true,
            30,
            5
        ),
        /429 on call \d+/
    )
    assert.ok(calls > 1, "it gave up on the first error")
})

test("pollUntil names both the last value and the last error when reads both answered and threw", async () => {
    let calls = 0

    await assert.rejects(
        pollUntil(
            async () => {
                calls += 1
                if (calls === 1) return 0
                throw new Error("status page answered 503")
            },
            (count) => count === 1,
            30,
            5
        ),
        /not met within 30ms \(last value: 0; last error: status page answered 503\)/
    )
})

test("pollUntil retries when the readiness predicate throws on a half-formed answer", async () => {
    let calls = 0

    const value = await pollUntil(
        async () => ((calls += 1) >= 3 ? { members: [1] } : ({} as { members: number[] })),
        (state) => state.members.length === 1,
        1000,
        1
    )

    assert.deepEqual(value, { members: [1] })
    assert.equal(calls, 3)
})

test("readJson throws on a non-2xx status, so a poll retries an error body until a real answer", async () => {
    let requests = 0
    const server = createServer((_request, response) => {
        requests += 1
        const failing = requests === 1
        response.writeHead(failing ? 500 : 200, { "content-type": "application/json" })
        response.end(JSON.stringify(failing ? { error: "internal error" } : { root: "7" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/revocations/snapshot`
    try {
        await assert.rejects(readJson(url), /\/v1\/revocations\/snapshot returned 500/)
        requests = 0

        const snapshot = await pollUntil(() => readJson<{ root?: string }>(url), rootMovedFrom("5"), 1000, 1)

        assert.deepEqual(snapshot, { root: "7" })
        assert.equal(requests, 2)
    } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test("the root-moved predicate is ready only for a root that is present and not the previous one", () => {
    const moved = rootMovedFrom("5")

    assert.equal(moved({}), false)
    assert.equal(moved({ root: "5" }), false)
    assert.equal(moved({ root: "6" }), true)
})

test("the fatal handler exits even when stopping never settles", async () => {
    const exits: number[] = []
    const fatal = createFatalHandler({
        cleanup: () => new Promise<void>(() => {}),
        write: () => {},
        exit: (code) => exits.push(code),
        cleanupTimeoutMs: 20
    })

    await fatal("uncaughtException", new Error("boom"))

    assert.deepEqual(exits, [1])
})
