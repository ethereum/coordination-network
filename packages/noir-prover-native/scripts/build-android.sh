#!/usr/bin/env bash
# Regenerates the Android native library and the React Native bindings.
#
# Output is gitignored: the ~26 MB .so does not belong in the repository. Run this once after a
# clone, and again whenever rust/src changes.
#
# Prerequisites, all of which mopro or cargo will otherwise fail on obscurely:
#   - rustup target aarch64-linux-android
#   - cargo install cargo-ndk
#   - Zig on PATH. The prebuilt barretenberg archive is built against Zig's libc++ (std::__1);
#     the NDK's is std::__ndk1 and the two are ABI-incompatible.
#   - ANDROID_NDK_HOME, and JAVA_HOME pointing at a JDK 17
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPTS/../rust"

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to an installed NDK}"
: "${JAVA_HOME:?set JAVA_HOME to a JDK 17}"
command -v zig >/dev/null || { echo "zig not on PATH; see the comment above" >&2; exit 1; }

TRIPLE=aarch64-linux-android

# A stale library would otherwise pass every check below: `mopro build` exits 0 even when it
# fails, so this only trusts a library it just watched get written.
rm -f "target/$TRIPLE/release/libnoir_prover_native.so"

# The .so embeds the path of every source file it compiles, panic messages included, so the build
# would publish the maintainer's home directory. rust/.cargo/config.toml includes this file, which
# remaps those paths to neutral prefixes. It is a cfg table because mopro sets the triple's rustflags
# in the environment, which replaces the triple's table and build.rustflags, while a cfg table is
# merged with it. The repo root is listed last: the later mapping wins for a path under both.
cat > .cargo/remap.toml <<EOF
[target.'cfg(target_os = "android")']
rustflags = [
    "--remap-path-prefix=$HOME=/build/home",
    "--remap-path-prefix=$(git rev-parse --show-toplevel)=/build/src",
]
EOF

mopro build --mode release --platforms react-native --architectures "$TRIPLE" --no-auto-update

# mopro regenerates build.gradle from scratch every run, discarding edits, so this reapplies the
# patch. It narrows abiFilters to the ABIs jniLibs has a library for, and fails configuration when
# the first requested ABI has none.
git apply "$SCRIPTS/build-gradle-abis.patch" || {
    echo "build.gradle is not fresh mopro output, so mopro build most likely failed; read its output above" >&2
    exit 1
}

# Same problem, but these are edited in place rather than by patch, so the committed copy is the
# edit and this restores it. mopro's own package.json carries its template's name and points `types`
# and `default` at a `lib/` it never builds, which breaks the app's dependency; the rest is
# formatting and template leftovers. The template's turbo and babel configs are unused and removed.
# Only the generated directories are meant to change.
git checkout -- Config.toml MoproReactNativeBindings/package.json MoproReactNativeBindings/tsconfig.json \
    MoproReactNativeBindings/tsconfig.build.json MoproReactNativeBindings/src/NativeMoproFfi.ts \
    MoproReactNativeBindings/src/index.tsx MoproReactNativeBindings/src/index.web.ts
rm -f MoproReactNativeBindings/turbo.json MoproReactNativeBindings/babel.config.js

"$SCRIPTS/package-android-libs.sh"
