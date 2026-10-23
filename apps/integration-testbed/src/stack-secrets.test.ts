import assert from "node:assert/strict"
import { readFileSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"
import type { Hex32 } from "@coordination-network/credential"
import type { StackDescriptor } from "./serve"
import {
    buildStackSecrets,
    dashboardHeaders,
    hasDashboardKey,
    memberServerHeaders,
    operatorDashboardUrl,
    pairingUrl,
    stackSecretsFile,
    writeStackSecrets
} from "./stack-secrets"

const A = `0x${"aa".repeat(32)}` as Hex32
const B = `0x${"bb".repeat(32)}` as Hex32

/** Partial: only the fields the helpers read. */
const STACK = {
    dashboardUrl: "http://192.168.1.50:8080",
    members: [
        { name: "Org 1", networkId: A },
        { name: "Org 2", networkId: B }
    ]
} as unknown as StackDescriptor

const TWO_ORGS = [
    { networkId: A, memberServerToken: "token-a" },
    { networkId: B, memberServerToken: "token-b" }
]

test("buildStackSecrets keys each token by networkId and draws a fresh 32-byte dashboard key", () => {
    const one = buildStackSecrets(TWO_ORGS)
    const two = buildStackSecrets([])

    assert.deepEqual(one.memberServerTokens, { [A]: "token-a", [B]: "token-b" })
    assert.match(one.dashboardKey, /^[0-9a-f]{64}$/)
    assert.notEqual(one.dashboardKey, two.dashboardKey)
})

test("memberServerHeaders sends that org's own token, and throws for an org it has none for", () => {
    const secrets = buildStackSecrets([TWO_ORGS[0]])

    assert.deepEqual(memberServerHeaders(secrets, STACK.members[0]), { authorization: "Bearer token-a" })
    assert.throws(() => memberServerHeaders(secrets, STACK.members[1]), /Org 2/)
})

test("dashboardHeaders carries the dashboard key as a bearer token", () => {
    const secrets = { dashboardKey: "k".repeat(64), memberServerTokens: {} }

    assert.deepEqual(dashboardHeaders(secrets), { authorization: `Bearer ${"k".repeat(64)}` })
})

test("hasDashboardKey accepts exactly 'Bearer <key>' and nothing else", () => {
    const key = "ab".repeat(32)

    assert.equal(hasDashboardKey(`Bearer ${key}`, key), true)
    for (const header of [
        undefined,
        "",
        key,
        `bearer ${key}`,
        `Bearer ${key}x`,
        `Bearer ${key.slice(1)}`,
        `Bearer ${"cd".repeat(32)}`,
        "Bearer ",
        `Basic ${key}`
    ]) {
        assert.equal(hasDashboardKey(header, key), false, String(header))
    }
})

test("pairingUrl puts the org's index and token in the fragment, which no HTTP client sends", () => {
    const secrets = buildStackSecrets(TWO_ORGS)

    assert.equal(pairingUrl(STACK, secrets, 1), "http://192.168.1.50:8080/stack.json#org=1&token=token-b")
    assert.throws(() => pairingUrl(STACK, secrets, 2), /index 2/)
})

test("operatorDashboardUrl carries the dashboard key in the fragment too", () => {
    const secrets = { dashboardKey: "k".repeat(64), memberServerTokens: {} }

    assert.equal(operatorDashboardUrl(STACK, secrets), `http://192.168.1.50:8080/#key=${"k".repeat(64)}`)
})

test("stackSecretsFile lists every org's token and pairing link under its name, for the operator", () => {
    const secrets = buildStackSecrets(TWO_ORGS)

    assert.deepEqual(stackSecretsFile(STACK, secrets), {
        dashboardKey: secrets.dashboardKey,
        operatorDashboardUrl: `http://192.168.1.50:8080/#key=${secrets.dashboardKey}`,
        members: [
            {
                name: "Org 1",
                networkId: A,
                memberServerToken: "token-a",
                pairingUrl: "http://192.168.1.50:8080/stack.json#org=0&token=token-a"
            },
            {
                name: "Org 2",
                networkId: B,
                memberServerToken: "token-b",
                pairingUrl: "http://192.168.1.50:8080/stack.json#org=1&token=token-b"
            }
        ]
    })
})

test("writeStackSecrets writes an owner-only file outside the repo, where no Vite dev server reaches it", () => {
    const secrets = buildStackSecrets(TWO_ORGS)
    const path = writeStackSecrets(STACK, secrets)
    const repoRoot = resolve(__dirname, "..", "..", "..")

    // Vite serves the whole workspace at /@fs/.
    assert.equal(path.startsWith(`${repoRoot}/`), false, `${path} is inside ${repoRoot}`)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(resolve(path, "..")).mode & 0o777, 0o700)
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), stackSecretsFile(STACK, secrets))
    const second = writeStackSecrets(STACK, secrets)
    assert.notEqual(second, path, "a fresh directory each run")

    for (const written of [path, second]) rmSync(resolve(written, ".."), { recursive: true, force: true })
})
