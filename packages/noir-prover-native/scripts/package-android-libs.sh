#!/usr/bin/env bash
# Copies the built Android library into MoproReactNativeBindings' jniLibs, checking that it is
# the Zig-linked build from rust/target and not rn-bindgen's NDK-linked scratch copy under
# rust/build. No libc++_shared.so goes into jniLibs or the tarball; CMake already packages the
# NDK's when the app builds. Also records android-libs.sha256, which check-android-libs.sh enforces.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../rust"

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to an installed NDK}"
NM="$(ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-nm)"

BINDINGS="MoproReactNativeBindings"
JNI_LIBS="$BINDINGS/android/src/main/jniLibs"
TRIPLE=aarch64-linux-android
ABI=arm64-v8a

SRC="target/$TRIPLE/release/libnoir_prover_native.so"
[ -f "$SRC" ] || { echo "missing $SRC; run scripts/build-android.sh first" >&2; exit 1; }

# `nm_output` is its own assignment so a failing `nm` (a non-ELF or truncated file) stops the
# script via `set -e`; only the follow-up `grep -c` (which exits 1 on zero matches, the
# success case) gets `|| true`.
#
# Android's libc++ exports std::__ndk1, not std::__1. Zig links barretenberg's std::__1
# libc++ in statically, so any std::__1 import means the NDK-linked relink, which dlopen fails on.
nm_output="$("$NM" -D --undefined-only "$SRC")"
undefined="$(printf '%s\n' "$nm_output" | grep -c 'St3__1' || true)"
[ "$undefined" -eq 0 ] || {
    echo "$ABI's libnoir_prover_native.so imports std::__1 ($undefined symbols) - it is the NDK-linked scratch build, not the Zig-linked one" >&2
    exit 1
}

# build-android.sh remaps these paths through cargo's `include`, which needs cargo 1.94 or newer, and an
# environment RUSTFLAGS silently overrides it. Either way the build succeeds, so look for the leak here.
for private in "$HOME" "$(git rev-parse --show-toplevel)"; do
    if LC_ALL=C grep -a -F -q -- "$private" "$SRC"; then
        echo "$SRC contains '$private'; the path remap did not apply (cargo older than 1.94, or RUSTFLAGS set)" >&2
        exit 1
    fi
done

rm -rf "$JNI_LIBS"

mkdir -p "$JNI_LIBS/$ABI"
cp "$SRC" "$JNI_LIBS/$ABI/"

# The generated bindings hard-code the UniFFI checksums this library must match, so they are pinned
# with it. Sorted so the file does not depend on directory order. Dotfiles are skipped, matching
# check-android-libs.sh.
{
    echo "$JNI_LIBS/$ABI/libnoir_prover_native.so"
    find "$BINDINGS/src/generated" "$BINDINGS/cpp/generated" -type f ! -path '*/.*' | LC_ALL=C sort
} | xargs shasum -a 256 > android-libs.sha256

# Keyed on the crate, not the npm package: the library changes only when the Rust does. The marker
# travels in the tarball, so fetch-android-libs.sh and check-android-libs.sh can tell which version
# is unpacked.
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)"
echo "$VERSION" > "$JNI_LIBS/VERSION"

echo "built ABI:"
ls "$JNI_LIBS"

# Packaged for a GitHub release, so consumers and EAS builders need no Rust toolchain.
TARBALL="../noir-prover-native-android-v${VERSION}.tar.gz"
# bsdtar adds AppleDouble ._* members and PAX xattr headers for files with xattrs. The variable and
# --no-xattrs stop that, and GNU tar accepts both.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TARBALL" -C "$BINDINGS/android/src/main" jniLibs
echo "packaged $(cd .. && pwd)/$(basename "$TARBALL") ($(du -h "$TARBALL" | cut -f1))"
echo "upload it to the release tagged noir-prover-native-v${VERSION}"
