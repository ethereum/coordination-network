# `@coordination-network/noir-prover-native`

A native UltraHonk prover for `@coordination-network/circuits`, for React Native.

Hermes has no `WebAssembly`, so `ZkCredentialProofSystem` — which loads `@aztec/bb.js` — cannot run
on a phone. This package proves the same circuit in Rust and returns a proof the unchanged SDK
verifier accepts, so `apps/issuer-service` needs no knowledge that the proof came from a phone.

## Install

```sh
yarn add @coordination-network/noir-prover-native @coordination-network/noir-prover-ffi
```

`@coordination-network/noir-prover-ffi` is the React Native binding to the Rust crate and carries the
compiled `arm64-v8a` library, so an app needs no Rust toolchain. It supports Android only; there is no
iOS library. Its README lists the build settings an app needs.

Metro also has to resolve `@aztec/bb.js` and `@noir-lang/noir_js`, which `@coordination-network/credential`
imports dynamically for its WASM prover, and neither runs under Hermes. Stub both in `metro.config.js`
the way [`apps/user-app`](https://github.com/ethereum/coordination-network/blob/main/apps/user-app/metro.config.js) does.

## The crate

`rust/` wraps [`zkpassport/noir_rs`](https://github.com/zkpassport/noir_rs) at tag
`v1.0.0-beta.22-1`, generated from mopro's Noir template with the dependency re-pointed.

The tag is not a preference. mopro 0.3.7 pins `zkmopro/noir-rs` at `v1.0.0-beta.19`, whose
`barretenberg-rs` is 4.2.0 and whose `Program::deserialize_program` cannot read a nargo beta.22
artifact at all — it fails before reaching barretenberg. The zkpassport tag pins
`barretenberg-rs = 5.0.0` and acvm/nargo `v1.0.0-beta.22`, matching this repo's `@aztec/bb.js` 5.0.0
and pinned Nargo exactly. Its default proof settings are byte-identical to `bb.js`'s, so nothing has
to be configured for the two to agree.

Three entry points:

```rust
fn init_srs(circuit_path: String, srs_path: String, expected_hash: String) -> Result<u32, MoproError>;
fn credential_verification_key(circuit_path: String, low_memory_mode: bool) -> Result<Vec<u8>, MoproError>;
async fn prove_credential(circuit_path: String, witness: Vec<String>, vk: Vec<u8>, low_memory_mode: bool)
    -> Result<CredentialProof, MoproError>;
```

`witness` is the circuit's parameters flattened depth-first in ABI order — 239 values for this
circuit — which `zkPresentationInputsToWitness` in `@coordination-network/credential` produces.

### Proving runs on its own thread

`prove_credential` is an `async fn`, so UniFFI hands TypeScript a promise and the app's JS thread
stays free to paint while a proof runs — it used to freeze for the whole second. The work itself is
blocking C++, so the export spawns a plain `std::thread` named `noir-prover` and awaits its result
over a oneshot channel; there is no async runtime involved, and uniffi drives the future.

That thread asks for a 64 MiB stack. Barretenberg recurses far past the 2 MiB a thread gets by
default, and the JS thread it used to borrow is itself generously sized, so the default would turn
a working proof into a stack overflow.

`prove_credential_blocking` is the same work without the hand-off. It is not on the FFI surface;
it is what the prover thread runs, and what `rust/tests/credential.rs` measures.

The two setup calls stay synchronous: UniFFI returns a promise only for an `async fn`, and both are
short and happen once, before the first proof.

**Proofs are poseidon2-oracle.** Nothing in the SDK passes proof options to
`verifyZkPresentationProof`, so a keccak proof would be rejected with no useful error.

### The artifact has to be the one the caller was built against

`expected_hash` is the compiled artifact's `hash` field, as the caller knows it. An app ships the
ABI and the artifact as two separate files — the user app bundles a 5 KB ABI module and a 1.9 MB
binary asset — so a rebuild can leave one newer than the other. A witness flattened against one
circuit and proved against another yields a proof that simply fails verification, with nothing in
the failure pointing at the cause. `init_srs` compares the two and refuses, naming both hashes and
the script that resyncs them.

### Why the split happens in Rust

`prove_ultra_honk` returns one flat buffer: `[u32 big-endian count][count × 32-byte public inputs][proof fields]`.
`bb.js`'s `ProofData` wants the two apart, with the public inputs _not_ prefixed to the proof bytes.
Getting that wrong produces a `PROOF_INVALID` that reads like a cryptographic failure rather than a
framing bug — the proof is exactly `32 × count` bytes too long. `CredentialProof` is therefore
returned already separated, and TypeScript never learns the length prefix exists.

## Building

Prerequisites beyond a Rust toolchain:

- cargo 1.94 or newer, for the `include` key in `rust/.cargo/config.toml` that strips local paths.
- `cargo install cargo-ndk`
- **Zig on `PATH`** (`brew install zig`). The prebuilt barretenberg static library is built against
  Zig's libc++ (`std::__1`); the NDK's libc++ is `std::__ndk1` and the two are ABI-incompatible, so
  the Android link has to go through Zig. mopro checks for this and refuses without it.
- `ANDROID_NDK_HOME`, and `JAVA_HOME` pointing at a JDK 17.
- `nargo` 1.0.0-beta.22, only to recompile the circuit; `@coordination-network/zk-artifacts`
  ships the compiled one this crate proves against.

`barretenberg-rs` downloads a prebuilt static archive per architecture rather than building C++, so
there is no cmake or ninja to arrange — but the build needs network access, and a network-isolated
CI has to pre-populate `BB_LIB_DIR`.

Most people never need any of it. The bindings' TypeScript, C++ and Gradle sources are committed
(244 KB); only the compiled libraries are not, and `scripts/fetch-android-libs.sh` pulls those from
the release matching the crate's version in `rust/Cargo.toml`. That is what an EAS build should run.

```sh
./scripts/fetch-srs.sh                # 8.4 MB of SRS, gitignored
./scripts/fetch-android-libs.sh       # prebuilt arm64-v8a .so, from the release
cd rust && cargo test --release       # proves the real circuit on the desktop
```

A maintainer produces the library instead of fetching it, once per release:

1. `scripts/build-android.sh` runs `mopro build`, reapplies `scripts/build-gradle-abis.patch` to
   `MoproReactNativeBindings/android/build.gradle`, then runs `scripts/package-android-libs.sh`.
2. That script copies the Zig-linked library (`arm64-v8a`, the only ABI this package ships) into
   `jniLibs`, writes `rust/android-libs.sha256`, and leaves a tarball.
3. Commit `rust/android-libs.sha256`.
4. Upload the tarball to the release tagged `noir-prover-native-v<crate version>`, then push the version
   tag. The crate version is the one in `rust/Cargo.toml`, not the npm one: the library changes only when
   the Rust does.

`android-libs.sha256` pins the library and the generated bindings together, because the bindings hard-code
UniFFI checksums the library must match. The bindings' `prepack` is `scripts/fetch-android-libs.sh`: it keeps
a library that matches the file, otherwise unpacks only the release's library and version marker, then runs
the check. A regenerated binding fails it until the file is re-recorded, and so does a bad release asset; a
rebuilt library that was not re-recorded is replaced by the released one. The library is about
26 MB, which is why it is a release artifact rather than a commit, exactly as the SRS is a download rather
than a blob. No `libc++_shared.so` goes into `jniLibs`: CMake already packages the NDK's one when the app
builds, and a second copy broke the bindings' `mergeDebugNativeLibs`.

`mopro build` **exits 0 even when it fails**, printing the reason to stdout, so
`scripts/build-android.sh` checks for a freshly written library rather than the exit code. mopro
can also silently fall back to an NDK-linked scratch build meant only for uniffi-bindgen and never
run on a device. `scripts/package-android-libs.sh` catches that by verifying the shipped library
imports no `std::__1` symbol before packaging it.

## The SRS

`scripts/fetch-srs.sh` pulls the first 131 073 G1 points (8 388 672 bytes) of Aztec's structured
reference string with an HTTP range request. It is gitignored: 8 MB of public, reproducible data
does not belong in the repository, and the fetch takes under a second.

Barretenberg will range-request it itself when handed no path, but it has no disk cache, so every
process start pays roughly 23 s. With a bundled file, SRS setup is about 190 ms.

SRS setup is process-global and first-call-wins since barretenberg 5.x, so an app must call
`init_srs` once, before its first proof, with the largest circuit it will ever prove.

## Measurements

Apple M5 Max, release build, warm SRS:

|               |                          |
| ------------- | ------------------------ |
| prove         | 711 ms                   |
| peak RSS      | 339 MiB                  |
| proof         | 14 656 bytes, 458 fields |
| public inputs | 7                        |

339 MiB is the number to watch on a low-end Android device; `low_memory_mode` exists for it and was
not needed here. Verification of this crate's output by `verifyZkPresentationProof` takes ~1 s and
returns the same two roots as a `bb.js` proof of the same inputs — `scripts/verify-native-proof.ts`
is that cross-check, and it is what makes the whole approach safe to rely on.

An arm64 emulator running API 30, not a phone — real hardware has not been measured yet:

|                  |                          |
| ---------------- | ------------------------ |
| SRS init         | 256 ms                   |
| verification key | 535 ms                   |
| prove            | 991 ms                   |
| peak RSS         | 274 MiB                  |
| proof            | 14 656 bytes, 458 fields |
| public inputs    | 7                        |

Through the user app on an arm64 emulator running API 34, timed from Approve on the consent sheet to
the member app's callback — so it covers loading the library, setup, proving, posting the proof and
the member server's verification:

|                     |       |
| ------------------- | ----- |
| first presentation  | 5.6 s |
| second presentation | 2.2 s |

The first pays for the `dlopen`, SRS setup and the verification key; the second finds all three
already done. The second was taken with the dev server suspended, which is what the dedicated thread
and the app's static `require` are both there for: no bundle segment is fetched at proof time and no
reload interrupts a proof in flight.
