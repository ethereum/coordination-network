# Android bench

Proves the credential circuit inside an app process, so lmkd treats it like a real app, and prints
the `NOIR_*` marker lines from `bench/CONTRACT.md` to logcat (tag `NOIR`). The host runner drives it
through `bench_workload.json`.

- `app/`: a trivial Activity that keeps the screen on.
- `app/src/androidTest/.../BenchTest.kt`: reads `bench_config.json`, stages the inputs, launches the
  Activity, takes a partial wake lock and calls the Rust bench (`rust/src/bench.rs`) through the
  generated Kotlin bindings. Iteration 0 is cold: it loads the SRS and circuit, derives the
  verification key, then proves.

Build with `scripts/build-android-bench.sh`, the only build that enables the crate's `bench` cargo
feature (`rust/src/bench.rs` and its `bench_*` exports). `scripts/build-android.sh` and a plain
`cargo build` do not contain them. It builds the library with `mopro build` in a scratch
copy of `rust/` (`$NOIR_BENCH_SCRATCH`), refuses a library that imports `std::__1`, and drops the
library and bindings into the gitignored `app/src/main/{jniLibs,kotlin}`.

Results from ten phones, run on 28 and 30 October 2026, are in [`results/`](results/README.md).

## Primitives

`bench_workload_primitives.json` (workload `noir-primitives`) runs CSP's SHA-256 over 2 KB and ECDSA
P-256 verify circuits through the same harness, as steps `sha256` and `ecdsa`. A step other than
`prove` takes its files from the config's `artifacts` map, relative to the push directory:

```json
{
    "steps": ["sha256"],
    "artifacts": { "sha256": { "circuit": "sha256.json", "srs": "g1-262145.dat", "witness": "sha256-witness.json" } }
}
```

`circuits/build.sh` compiles the two circuits with nargo beta.22 and writes the artifacts and the
flat witnesses; SHA-256 proves a fixed message whose byte i is i mod 256. SHA-256 needs the larger
SRS: `scripts/fetch-srs.sh 262145`. Barretenberg keeps the first SRS of a process, so a config with an
`artifacts` entry runs one step per process and the test refuses more. `SIZES` reports `srs_bytes`
as the points the circuit loaded times 64, not the size of the file. Proofs land in
`out/<step>.proof`, and `scripts/verify-device-proof.sh` checks each one.

## Files on the device

Nothing is bundled in the APKs. The runner pushes the circuit, the SRS and `bench_config.json` into
`/sdcard/zkbench/org.coordination.nbench/`, which the shell can write on every API level (the app's
own external files dir is not writable by the shell on Android 11). The app holds all-files access:
`MANAGE_EXTERNAL_STORAGE`, plus `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` up to API 29.
After installing, the runner does:

```sh
adb shell appops set org.coordination.nbench MANAGE_EXTERNAL_STORAGE allow
adb shell mkdir -p /sdcard/zkbench/org.coordination.nbench   # and pm grant the two storage permissions on API <= 29
```

Before the cold iteration the test copies the circuit and SRS into the app's `filesDir` and drops
both copies from the page cache (`bench_stage_file`), untimed. The cold load then reads app-private
storage, where a production app keeps its keys.

## Proof out

Every successful iteration overwrites `/sdcard/zkbench/org.coordination.nbench/out/<step>.proof` (`prove.proof` for the credential step), JSON
of `{"proof", "publicInputs"}`. Pull it and verify it against the SDK verifier and the committed
circuit:

```sh
adb pull /sdcard/zkbench/org.coordination.nbench/out ./out
scripts/verify-device-proof.sh ./out   # non-zero when rejected; the manifest's `verify` runs this
```

## Notes

Cold iterations include a verification-key derivation. The app derives it once, on first launch,
and caches it in AsyncStorage: `load_ms` covers it and `vk_ms` reports it on its own.

`srs_ms` and `vk_ms` each include reading and parsing `circuit.json`, because `init_srs` and
`credential_verification_key` each do, as in production. `load_ms` is their sum, which is what the
app pays on its first launch; later cold starts skip the VK and pay about `srs_ms`. The circuit's hash and size are read once before the clock starts, as an
app already knows them, and the file is dropped from the page cache again before `init_srs`.
Warm `prove_ms` includes re-reading `circuit.json`, because `prove_credential_blocking` does.

A failed write of `out/prove.proof` keeps the iteration: its ITER line prints, then a `NOIR_ERROR`.
