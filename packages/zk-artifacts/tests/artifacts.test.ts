import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
    credentialArtifactPath,
    credentialArtifactUrl,
    getCredentialCircuit,
    getCredentialVerificationKey
} from "../src/index"

// The circuit's public inputs are the contract @coordination-network/credential asserts
// before it will prove or verify, so a resync that changed them should fail here.
const PUBLIC_INPUTS = ["current_time", "challenge", "audience", "required_programme_hash", "required_country_code"]

test("resolves every artifact to a file that exists", () => {
    for (const artifact of ["circuit.json", "vk"] as const) {
        const path = credentialArtifactPath(artifact)
        assert.ok(existsSync(path), `${artifact} is missing from the package at ${path}`)
        assert.equal(credentialArtifactUrl(artifact).protocol, "file:")
    }
})

test("hands each caller its own URL rather than a shared one", () => {
    const first = credentialArtifactUrl("vk")
    first.pathname = "/tampered"
    assert.notEqual(credentialArtifactUrl("vk").pathname, "/tampered")
})

test("reads the compiled circuit with the ABI the credential SDK requires", async () => {
    const circuit = await getCredentialCircuit()

    assert.match(circuit.noir_version, /^1\.0\.0-beta\.22\+/)
    assert.ok(circuit.bytecode.length > 0)
    assert.deepEqual(
        circuit.abi.parameters.filter((parameter) => parameter.visibility === "public").map(({ name }) => name),
        PUBLIC_INPUTS
    )
    assert.equal(circuit.abi.return_type?.abi_type.kind, "tuple")
})

test("reads the verification key as the bytes barretenberg's verifier takes", async () => {
    const vk = await getCredentialVerificationKey()

    assert.ok(vk instanceof Uint8Array)
    assert.ok(vk.byteLength > 0)
    assert.equal(vk.byteLength % 32, 0)
})

// The artifacts are committed, so a circuit change that skips `yarn sync:zk-artifacts`
// would leave every consumer proving against the old circuit while all of CI stays green.
// nargo embeds each source file it compiled into the artifact's file map, so the committed
// artifact can be checked against the working tree without nargo or bb.
const CIRCUITS_DIR = fileURLToPath(new URL("../../circuits/", import.meta.url))
const RESYNC = "run `yarn sync:zk-artifacts` and commit the result"

test("was compiled from the circuit sources in this repository", async () => {
    const { file_map: fileMap } = await getCredentialCircuit()

    const embedded = Object.values(fileMap).filter(({ path }) => path.startsWith("packages/circuits/src/"))
    assert.ok(embedded.length > 0, "the artifact records no first-party sources")

    for (const { path, source } of embedded) {
        const onDisk = readFileSync(join(CIRCUITS_DIR, path.replace("packages/circuits/", "")), "utf8")
        assert.equal(source, onDisk, `${path} has changed since the artifact was built: ${RESYNC}`)
    }
})

// types.nr declares a struct and nothing else, so it carries no debug locations and nargo
// leaves it out of the file map above. It reaches the ABI instead, as the shape of the
// private `credential` input, which is what a change to it would alter.
test("was compiled from the Credential struct types.nr declares", async () => {
    const { abi } = await getCredentialCircuit()

    const credential = abi.parameters.find(({ name }) => name === "credential")
    assert.ok(credential && credential.type.kind === "struct", "the circuit takes no credential struct")
    assert.equal(credential.type.path, "types::Credential")

    const source = readFileSync(join(CIRCUITS_DIR, "src/types.nr"), "utf8")
    const body = /pub struct Credential\s*\{([^}]*)\}/.exec(source)
    assert.ok(body, "types.nr no longer declares `pub struct Credential`")

    const declared = [...body[1].matchAll(/^\s*(?:pub(?:\(crate\))?\s+)?(\w+)\s*:/gm)].map(([, name]) => name)
    assert.deepEqual(
        credential.type.fields.map(({ name }) => name),
        declared,
        `types.nr declares different credential fields than the artifact was built with: ${RESYNC}`
    )
})

test("was compiled against the circuit dependencies Nargo.toml pins", async () => {
    const { file_map: fileMap } = await getCredentialCircuit()
    const paths = Object.values(fileMap).map(({ path }) => path)
    const manifest = readFileSync(join(CIRCUITS_DIR, "Nargo.toml"), "utf8")

    const pinned = [...manifest.matchAll(/git = "https:\/\/([^"]+)"[^}]*?tag = "([^"]+)"/g)]
    assert.ok(pinned.length > 0, "Nargo.toml pins no git dependencies")

    for (const [, repository, tag] of pinned) {
        const prefix = `${repository.replace(/\.git$/, "")}/${tag}/`
        assert.ok(
            paths.some((path) => path.startsWith(prefix)),
            `the artifact was not built against ${prefix}: ${RESYNC}`
        )
    }
})
