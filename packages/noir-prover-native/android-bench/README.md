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

Every successful iteration overwrites `/sdcard/zkbench/org.coordination.nbench/out/prove.proof`, JSON
of `{"proof", "publicInputs"}`. Pull it and verify it against the SDK verifier and the committed
circuit:

```sh
adb pull /sdcard/zkbench/org.coordination.nbench/out ./out
scripts/verify-device-proof.sh ./out   # non-zero when rejected; the manifest's `verify` runs this
```

## Notes

Cold iterations include a verification-key derivation, as the app does on every cold start:
`load_ms` covers it and `vk_ms` reports it on its own.

`srs_ms` and `vk_ms` each include reading and parsing `circuit.json`, because `init_srs` and
`credential_verification_key` each do, as in production. `load_ms` is their sum, which is what the
app pays on a cold start. The circuit's hash and size are read once before the clock starts, as an
app already knows them, and the file is dropped from the page cache again before `init_srs`.
Warm `prove_ms` includes re-reading `circuit.json`, because `prove_credential_blocking` does.

A failed write of `out/prove.proof` keeps the iteration: its ITER line prints, then a `NOIR_ERROR`.
