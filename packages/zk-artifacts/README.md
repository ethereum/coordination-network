# zk-artifacts

The compiled zero-knowledge artifacts for the coordination network. The Noir
sources that produce them live in
[`@coordination-network/circuits`](../circuits); this package exists so an
application can prove and verify without installing nargo or barretenberg.

## Contents

| File                      | What it is                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `credential/circuit.json` | The credential circuit's ACIR bytecode, ABI and debug symbols, from `nargo compile` |
| `credential/vk`           | Its UltraHonk verification key, in barretenberg's binary encoding                   |

`bb write_vk` can also emit the key as a JSON array of field elements, and a
`vk_hash` beside it. Neither is published: `UltraHonkVerifierBackend.verifyProof`
takes the key as a `Uint8Array`, so the binary `vk` is the only form anything on
the verification path reads, and its hash is already derivable from it.

## Versions

Use the same version of this package and `@coordination-network/credential`.
Each release is built with specific Noir and Barretenberg versions, so mixing
releases can break proving or verification.

## Loading them

Reading a packaged file means `fs` on a server and `fetch` in a browser, so the
package ships an entry point for each. Both expose the same loaders, and neither
parses an artifact until you ask for it. The circuit, at two megabytes, stays a
separate file your runtime reads or fetches. The verification key is small
enough that a bundler may inline it as a `data:` URL instead, which `fetch`
handles the same way; raise `assetsInlineLimit` past 3680 bytes if you would
rather it stayed a file.

```ts
import { getCredentialCircuit, getCredentialVerificationKey } from "@coordination-network/zk-artifacts"

const circuit = await getCredentialCircuit() // CredentialCircuit
const vk = await getCredentialVerificationKey() // Uint8Array
```

A bundler picks the browser build through the `browser` export condition. Import
`@coordination-network/zk-artifacts/browser` to ask for it outright, which is
worth doing in a file that only ever runs in a worker or a page.

| Export                             | Node | Browser | Returns                                                                        |
| ---------------------------------- | ---- | ------- | ------------------------------------------------------------------------------ |
| `getCredentialCircuit()`           | ✓    | ✓       | `Promise<CredentialCircuit>`                                                   |
| `getCredentialVerificationKey()`   | ✓    | ✓       | `Promise<Uint8Array>`                                                          |
| `credentialArtifactUrl(artifact)`  | ✓    | ✓       | `URL`, a `file:` one on Node and the bundler's asset URL in a browser          |
| `credentialArtifactPath(artifact)` | ✓    | no      | `string`, an absolute path, for callers that take one rather than the contents |

The browser build has no `credentialArtifactPath`: there is no filesystem to
point at, so use `credentialArtifactUrl` there instead.

`CredentialCircuit` is noir_js's `CompiledCircuit` plus the `noir_version` and
`hash` nargo records but noir_js does not model, so a caller can see which
compiler produced the artifact it is proving against. `artifact` is
`"circuit.json"` or `"vk"`. The raw files also stay addressable as
`@coordination-network/zk-artifacts/credential/circuit.json` and
`.../credential/vk` for tooling that wants to resolve them itself.

`@coordination-network/credential` consumes the circuit as its
`ZkCredentialCircuit`. It builds its backend with `new UltraHonkBackend(bytecode)`,
which derives the verification key from the bytecode on every run, so nothing in
this repository reads `vk` yet. It is published for verifiers that would rather
pin the circuit's identity than recompute it from 1.8MB of bytecode.

## Regenerating

The artifacts are committed. The release workflow publishes with Node alone, so
nothing in CI can rebuild them, and pinning them keeps every consumer proving
against the same circuit the maintainers verified.

```sh
yarn sync:zk-artifacts
```

That runs `scripts/sync.ts`, which compiles `packages/circuits`, copies the
result here, writes the verification key, and checks `bb --version` and the
compiled circuit's `noir_version` against the `@aztec/bb.js` and
`@noir-lang/noir_js` versions `@coordination-network/credential` pins. A
mismatched pair fails inside barretenberg's deserializer at proving time rather
than here, so the check refuses to ship one.

nargo records an absolute path for every source file it reads. The script
rewrites those to be relative to the repository and to `~/nargo`, which keeps
the debug call stacks working, keeps the maintainer's home directory out of a
published package, and makes the artifact byte-identical across machines.

Run it, and commit the result, whenever the circuit or the toolchain changes.

## Verifying

Regenerating the artifacts from the circuit should reproduce exactly what is
published here. This needs the pinned toolchain, nargo 1.0.0-beta.22 and bb
5.0.0: a different nargo compiles different bytecode, and a different bb writes
a different key from the very same circuit.

`credential/vk` must come out byte-identical, and so must
`credential/circuit.json` apart from one thing: the `path` values inside
`file_map`, which nargo records as each file's location on the machine that
compiled it and the published copy carries relative to the repository.
Everything else matches, `bytecode` and `abi` included.

How you check that depends on how you regenerated. `yarn sync:zk-artifacts`
overwrites this package's own `packages/zk-artifacts/credential/`, so git is
the comparison: a clean `git diff -- credential` means both artifacts came
out identical, `file_map` paths included, since the script rewrites those
itself.

Running nargo and bb yourself leaves the output somewhere else, and sha256 is
a short way to compare the two copies. Each pair below has to print the same
digest. `shasum -a 256`, or `sha256sum` on Linux, over the key on each side:

```sh
shasum -a 256 credential/vk /path/to/your/vk
```

The circuit needs its `path` values dropped first. Run `jq` over both copies
and compare the two outputs, never an output against a raw file: `jq` reprints
the JSON in its own formatting, which changes the hash on its own.

```sh
jq -cS 'del(.file_map[].path)' credential/circuit.json | shasum -a 256
jq -cS 'del(.file_map[].path)' ../circuits/target/credential.json | shasum -a 256
```
