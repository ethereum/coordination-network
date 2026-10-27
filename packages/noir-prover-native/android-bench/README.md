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

Nothing is bundled in the APKs. The runner pushes the circuit and SRS from the manifest and writes
the config, all directly into the app's external files dir,
`/sdcard/Android/data/org.coordination.nbench/files/`. That is the one place an untrusted_app can
read what the shell wrote; `/data/local/tmp` is readable on permissive emulator images but not
reliably on production builds, and a subdirectory made by `adb push` is shell-owned, mode 770.

The shell cannot create that dir before the app has run (`secure_mkdirs failed: Permission denied`).
After installing, the runner does `adb shell mkdir -p <dir>`. If that fails, it runs
`am start -W -n org.coordination.nbench/.MainActivity` and then `am force-stop org.coordination.nbench`
before pushing: `MainActivity.onCreate` calls `getExternalFilesDir(null)`, which creates the dir.

Cold iterations time a verification-key derivation, which the contract's "no keygen on the device"
rule does not mention; `load_ms` includes it, and `vk_ms` reports it on its own.
Warm `prove_ms` includes re-reading `circuit.json`, because the app's `prove_credential_blocking`
does.
