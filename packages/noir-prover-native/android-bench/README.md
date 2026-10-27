# Android bench

Proves the credential circuit inside an app process, so lmkd treats it like a real app, and prints
the `NOIR_*` marker lines from `bench/CONTRACT.md` to logcat (tag `NOIR`). The host runner drives it
through `bench_workload.json`.

- `app/`: a trivial Activity that keeps the screen on.
- `app/src/androidTest/.../BenchTest.kt`: reads `bench_config.json`, launches the Activity, takes a
  partial wake lock, calls the Rust bench (`rust/src/bench.rs`) through the generated Kotlin bindings.
  Iteration 0 is cold, so it loads the SRS and circuit, derives the verification key, then proves.

Build with `scripts/build-android-bench.sh`. It builds the library with `mopro build` in a scratch
copy of `rust/` (`$NOIR_BENCH_SCRATCH`), refuses a library that imports `std::__1`, and drops the
library and bindings into the gitignored `app/src/main/{jniLibs,kotlin}`.

## Files on the device

Nothing is bundled in the APKs. The runner pushes the circuit and SRS from the manifest, and writes
the config, all under `/data/local/tmp/noir-bench/`. The app uid can read a world-readable file at a
known path there, while the shell cannot create the app's own external files dir before the app has
run (Android 11: `secure_mkdirs failed: Permission denied`).

Verified on an API 30 arm64 emulator only, with `run-as` and a real instrumentation run. API 31 to 36
are not checked; if SELinux refuses the read on a newer release, the test fails at `readText()` with a
permission error rather than producing a wrong number.

Cold iterations time a verification-key derivation, which the contract's "no keygen on the device"
rule does not mention; `load_ms` includes it, and `vk_ms` reports it on its own.
Warm `prove_ms` includes re-reading `circuit.json`, because the app's `prove_credential_blocking`
does.
