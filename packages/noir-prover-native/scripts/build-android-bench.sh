#!/usr/bin/env bash
# Builds the Android bench: the arm64-v8a library, its Kotlin UniFFI bindings, and the app and
# androidTest APKs listed in android-bench/bench_workload.json.
#
# `mopro build` rewrites Config.toml and build.gradle in the tree it runs in, so it runs on a copy of
# rust/ under $NOIR_BENCH_SCRATCH, which also keeps cargo's cache between runs. Nothing in the
# repo's MoproReactNativeBindings changes.
#
# Prerequisites are build-android.sh's: the aarch64-linux-android rustup target, cargo-ndk, zig and
# mopro 0.3.7.
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$PKG/android-bench"
SCRATCH="${NOIR_BENCH_SCRATCH:-$HOME/.cache/noir-bench-build}"

export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/27.1.12297006}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
command -v zig >/dev/null || { echo "zig not on PATH; see build-android.sh" >&2; exit 1; }

TRIPLE=aarch64-linux-android
NM="$(ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-nm)"

mkdir -p "$SCRATCH"
rsync -a --delete \
    --exclude target --exclude build --exclude 'MoproReactNativeBindings' --exclude 'MoproAndroidBindings' \
    "$PKG/rust/" "$SCRATCH/rust/"

# `mopro build` exits 0 even when it fails, so only trust a library it just wrote.
rm -rf "$SCRATCH/rust/MoproAndroidBindings"
(cd "$SCRATCH/rust" && mopro build --mode release --platforms android --architectures "$TRIPLE" --no-auto-update)

SO="$SCRATCH/rust/MoproAndroidBindings/jniLibs/arm64-v8a/libnoir_prover_native.so"
[ -f "$SO" ] || { echo "mopro build wrote no $SO; read its output above" >&2; exit 1; }

# Same check as package-android-libs.sh: barretenberg is built against Zig's libc++ (std::__1), and
# the NDK's is std::__ndk1, so a std::__1 import means a relink dlopen cannot load.
imports="$("$NM" -D --undefined-only "$SO" | grep -c 'St3__1' || true)"
[ "$imports" -eq 0 ] || { echo "$SO imports std::__1 ($imports symbols)" >&2; exit 1; }

rm -rf "$BENCH/app/src/main/jniLibs" "$BENCH/app/src/main/kotlin"
mkdir -p "$BENCH/app/src/main/jniLibs" "$BENCH/app/src/main/kotlin"
cp -r "$SCRATCH/rust/MoproAndroidBindings/jniLibs/arm64-v8a" "$BENCH/app/src/main/jniLibs/"
cp -r "$SCRATCH/rust/MoproAndroidBindings/uniffi" "$BENCH/app/src/main/kotlin/"

(cd "$BENCH" && ./gradlew --no-daemon :app:assembleDebug :app:assembleDebugAndroidTest)

echo "built:"
ls -1 "$BENCH"/app/build/outputs/apk/debug/*.apk "$BENCH"/app/build/outputs/apk/androidTest/debug/*.apk
