#!/usr/bin/env bash
# Downloads the prebuilt Android library for the crate version in rust/Cargo.toml.
#
# It is ~26 MB, so it lives on a GitHub release rather than in git, the same choice as the SRS.
# Run this after a clone, and in any build (EAS included) that has no Rust toolchain.
# To produce it instead, run scripts/build-android.sh, which needs Rust, cargo-ndk, Zig and the NDK.
#
# It is the bindings' `prepack`, so the release for the crate version has to exist before a version tag
# is pushed. Only the archive's two jniLibs files are extracted, then check-android-libs.sh verifies them
# against rust/android-libs.sha256, so a bad asset fails the pack.
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$PKG/rust/Cargo.toml" | head -n 1)"
TAG="noir-prover-native-v${VERSION}"
DEST="$PKG/rust/MoproReactNativeBindings/android/src/main"

# The marker alone is not trusted: an extraction that died part-way leaves it beside a partial library,
# so the early exit needs the check to pass too.
if [ "$(cat "$DEST/jniLibs/VERSION" 2>/dev/null)" = "$VERSION" ] && "$PKG/scripts/check-android-libs.sh" 2>/dev/null; then
    echo "android libraries already present: $DEST/jniLibs"
    exit 0
fi
rm -rf "$DEST/jniLibs"

ASSET="noir-prover-native-android-v${VERSION}.tar.gz"
mkdir -p "$DEST"

# Named members only, so macOS AppleDouble entries and anything else in the archive never land.
MEMBERS=(jniLibs/VERSION jniLibs/arm64-v8a/libnoir_prover_native.so)

# Removed on failure so a partial extraction cannot be trusted by the next run.
if command -v gh >/dev/null; then
    if ! gh release download "$TAG" --pattern "$ASSET" --output - | tar -xzf - -C "$DEST" "${MEMBERS[@]}"; then
        rm -rf "$DEST/jniLibs"
        exit 1
    fi
elif ! curl --fail --location --silent --show-error \
    "https://github.com/ethereum/coordination-network/releases/download/${TAG}/${ASSET}" |
    tar -xzf - -C "$DEST" "${MEMBERS[@]}"; then
    rm -rf "$DEST/jniLibs"
    exit 1
fi

# Removed on failure so a rejected archive is never left behind.
"$PKG/scripts/check-android-libs.sh" || {
    rm -rf "$DEST/jniLibs"
    exit 1
}

echo "unpacked:"
ls "$DEST/jniLibs"
