import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { afterEach, test } from "node:test"
import * as browser from "../src/browser"
import * as node from "../src/index"

// Node's fetch has no `file:` scheme, so this stands in for the bundler-served asset: it serves
// whatever file the browser entry asked for, which is the same file the Node entry reads.
const realFetch = globalThis.fetch

function serveFiles(): string[] {
    const requested: string[] = []
    globalThis.fetch = (async (input: URL) => {
        requested.push(input.href)
        return new Response(await readFile(input))
    }) as typeof fetch
    return requested
}

afterEach(() => {
    globalThis.fetch = realFetch
})

test("points at the same files the Node entry reads", () => {
    for (const artifact of ["circuit.json", "vk"] as const) {
        assert.equal(browser.credentialArtifactUrl(artifact).href, node.credentialArtifactUrl(artifact).href)
    }
})

test("hands each caller its own URL rather than a shared one", () => {
    const first = browser.credentialArtifactUrl("vk")
    first.pathname = "/tampered"
    assert.notEqual(browser.credentialArtifactUrl("vk").pathname, "/tampered")
})

test("fetches the compiled circuit the Node entry reads", async () => {
    const requested = serveFiles()

    assert.deepEqual(await browser.getCredentialCircuit(), await node.getCredentialCircuit())
    assert.deepEqual(requested, [node.credentialArtifactUrl("circuit.json").href])
})

test("fetches the verification key as the bytes the Node entry reads", async () => {
    serveFiles()

    const vk = await browser.getCredentialVerificationKey()

    assert.ok(vk instanceof Uint8Array)
    assert.deepEqual(vk, await node.getCredentialVerificationKey())
})

test("names the artifact and status when the fetch fails", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404, statusText: "Not Found" })) as typeof fetch

    await assert.rejects(browser.getCredentialVerificationKey(), { message: "failed to fetch vk: 404 Not Found" })
})
