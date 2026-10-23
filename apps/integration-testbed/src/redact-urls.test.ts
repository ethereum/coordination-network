import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { connectToChain } from "./anvil"
import { StackActivityLog } from "./dashboard"
import { OperatorError } from "./operator-error"
import { describeError, redactUrls } from "./redact-urls"

const KEYED = "https://eth-sepolia.example.io/v2/SECRETKEY123?apikey=SECRET"

test("redactUrls keeps only the origin of each URL in a message", () => {
    const redacted = redactUrls(`HTTP request failed.\n\nStatus: 429\nURL: ${KEYED}\nVersion: viem@2`)

    assert.ok(!redacted.includes("SECRET"))
    assert.match(redacted, /URL: https:\/\/eth-sepolia\.example\.io\nVersion/)
})

test("redactUrls leaves a message without a URL alone", () => {
    assert.equal(redactUrls("execution reverted"), "execution reverted")
})

test("redactUrls cuts a URL with an upper-case scheme", () => {
    assert.equal(redactUrls("URL: HTTPS://eth-sepolia.example.io/v2/SECRETKEY"), "URL: https://eth-sepolia.example.io")
})

test("describeError keeps a keyed URL out of an error's message, stack and url", () => {
    const error = Object.assign(new Error(`HTTP request failed.\n\nURL: ${KEYED}`), { url: KEYED })
    error.stack = `Error: ${error.message}\n    at fetch (${KEYED})`

    const described = describeError(error)

    assert.ok(!described.includes("SECRET"))
    assert.match(described, /URL: https:\/\/eth-sepolia\.example\.io\n/)
})

test("describeError prints an operator error as its message alone", () => {
    assert.equal(describeError(new OperatorError("set STACK_HOST")), "set STACK_HOST")
})

test("describeError prints something that is not an error as a string", () => {
    assert.equal(describeError(`rejected ${KEYED}`), "rejected https://eth-sepolia.example.io")
})

test("the activity log never stores a keyed URL", () => {
    const activity = new StackActivityLog()

    activity.append("deploy", `RPC ${KEYED}; chain 11155111`)

    assert.ok(!activity.recent()[0].message.includes("SECRET"))
})

const OWNER_KEY = `0x${"11".repeat(32)}`

async function withEnvironment(settings: Record<string, string>, run: () => Promise<void>): Promise<void> {
    const saved = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]))
    Object.assign(process.env, settings)
    try {
        await run()
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}

test("connectToChain refuses a scheme-less RPC_URL without echoing it", async () => {
    await withEnvironment({ RPC_URL: "eth-sepolia.example.invalid/v2/SECRETKEY", OWNER_PRIVATE_KEY: OWNER_KEY }, () =>
        assert.rejects(connectToChain(), (error: unknown) => {
            assert.ok(error instanceof OperatorError)
            assert.match(error.message, /RPC_URL/)
            assert.ok(!error.message.includes("SECRETKEY"))
            return true
        })
    )
})

test("connectToChain refuses a malformed OWNER_PRIVATE_KEY without echoing it", async () => {
    for (const key of ["SECRETKEY", `0x${"11".repeat(31)}`, "11".repeat(32), `0x${"zz".repeat(32)}`]) {
        await withEnvironment({ RPC_URL: "http://127.0.0.1:1", OWNER_PRIVATE_KEY: key }, () =>
            assert.rejects(connectToChain(), (error: unknown) => {
                assert.ok(error instanceof OperatorError)
                assert.match(error.message, /OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key/)
                assert.ok(!error.message.includes(key))
                return true
            })
        )
    }
})

test("connectToChain names a missing setting as an operator error", async () => {
    await withEnvironment({ RPC_URL: "" }, () =>
        assert.rejects(
            connectToChain(),
            (error: unknown) => error instanceof OperatorError && /RPC_URL/.test(error.message)
        )
    )
})

test("connectToChain signs through a nonce manager and logs only the RPC origin", async () => {
    const rpc = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            const { id, method } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string }
            response.setHeader("content-type", "application/json")
            response.end(JSON.stringify({ jsonrpc: "2.0", id, result: method === "eth_chainId" ? "0x1" : "0x0" }))
        })
    })
    await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve))
    const { port } = rpc.address() as AddressInfo
    const messages: string[] = []
    try {
        await withEnvironment(
            { RPC_URL: `http://127.0.0.1:${port}/v2/SECRETKEY`, OWNER_PRIVATE_KEY: OWNER_KEY },
            async () => {
                const chain = await connectToChain((message) => messages.push(message))

                assert.ok(typeof chain.signer !== "string" && "nonceManager" in chain.signer)
            }
        )
    } finally {
        rpc.close()
    }

    assert.match(messages[0], new RegExp(`^RPC http://127\\.0\\.0\\.1:${port}; chain 1;`))
    assert.ok(!messages.join("\n").includes("SECRETKEY"))
})

test("connectToChain refuses an RPC_URL that is not an http(s) URL, before reading the key, without echoing it", async () => {
    for (const url of [
        "ftp://user:SECRETKEY@eth.example.invalid/",
        "file:///SECRETKEY",
        "http://",
        "https://exa mple/SECRETKEY"
    ]) {
        await withEnvironment({ RPC_URL: url, OWNER_PRIVATE_KEY: "not-a-key" }, () =>
            assert.rejects(connectToChain(), (error: unknown) => {
                assert.ok(error instanceof OperatorError)
                assert.match(error.message, /^RPC_URL must be an http\(s\) URL$/)
                return true
            })
        )
    }
})

test("connectToChain names a missing OWNER_PRIVATE_KEY as an operator error", async () => {
    const saved = process.env.OWNER_PRIVATE_KEY
    delete process.env.OWNER_PRIVATE_KEY
    try {
        await withEnvironment({ RPC_URL: "http://127.0.0.1:1" }, () =>
            assert.rejects(
                connectToChain(),
                (error: unknown) =>
                    error instanceof OperatorError && /^OWNER_PRIVATE_KEY must be set/.test(error.message)
            )
        )
    } finally {
        if (saved !== undefined) process.env.OWNER_PRIVATE_KEY = saved
    }
})
