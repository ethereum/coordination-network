#!/usr/bin/env bash
# Fails unless jniLibs holds exactly the arm64-v8a library for the crate version and rust/android-libs.sha256 matches.
# Runs at the end of fetch-android-libs.sh, the bindings' `prepack`, so a tarball never goes out without the .so,
# or with a library or bindings that drifted.
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JNI_LIBS="$PKG/rust/MoproReactNativeBindings/android/src/main/jniLibs"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$PKG/rust/Cargo.toml" | head -n 1)"

[ -f "$JNI_LIBS/arm64-v8a/libnoir_prover_native.so" ] || {
    echo "missing $JNI_LIBS/arm64-v8a/libnoir_prover_native.so; run scripts/fetch-android-libs.sh" >&2
    exit 1
}

found="$(cat "$JNI_LIBS/VERSION" 2>/dev/null || true)"
[ "$found" = "$VERSION" ] || {
    echo "jniLibs is for crate version '${found:-none}', rust/Cargo.toml says $VERSION; run scripts/fetch-android-libs.sh" >&2
    exit 1
}

# The hash file pins only the listed files while the package ships android/ whole, so anything else
# in jniLibs would go out unverified, and a library for another ABI would be the one loaded there.
entries="$(cd "$JNI_LIBS" && find . -mindepth 1 | LC_ALL=C sort)"
special="$(cd "$JNI_LIBS" && find . -mindepth 1 ! -type f ! -type d)"
expected="$(printf '%s\n' ./VERSION ./arm64-v8a ./arm64-v8a/libnoir_prover_native.so)"
{ [ -z "$special" ] && [ "$entries" = "$expected" ]; } || {
    echo "jniLibs must hold exactly VERSION and arm64-v8a/libnoir_prover_native.so as regular files; found:" >&2
    echo "$entries" >&2
    exit 1
}

# The hash file is the trust root, so it must list exactly what packaging pins, not whatever it says.
# Same file filter as package-android-libs.sh: dotfiles such as .DS_Store are never pinned.
BINDINGS="MoproReactNativeBindings"
listed="$(sed 's/^[0-9a-f]\{64\}  //' "$PKG/rust/android-libs.sha256" | LC_ALL=C sort)"
wanted="$(cd "$PKG/rust" && {
    echo "$BINDINGS/android/src/main/jniLibs/arm64-v8a/libnoir_prover_native.so"
    find "$BINDINGS/src/generated" "$BINDINGS/cpp/generated" -type f ! -path '*/.*'
} | LC_ALL=C sort)"
[ "$listed" = "$wanted" ] || {
    echo "rust/android-libs.sha256 must list exactly the library and the generated bindings; it lists:" >&2
    echo "$listed" >&2
    exit 1
}

(cd "$PKG/rust" && shasum -a 256 --strict -c --quiet android-libs.sha256) >&2 || {
    echo "the library or generated bindings differ from rust/android-libs.sha256; after a deliberate rebuild, run scripts/build-android.sh and commit the new file" >&2
    exit 1
}
