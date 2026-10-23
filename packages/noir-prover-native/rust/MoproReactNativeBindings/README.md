# @coordination-network/noir-prover-ffi

React Native bindings for the native UltraHonk prover behind `@coordination-network/noir-prover-native`. The package is a TurboModule that exposes the Rust crate to JavaScript through JSI, with the compiled Android library inside the tarball. `@coordination-network/noir-prover-native` does not depend on this package: it takes the module through its `loadModule` option, so an app installs both and passes this one in.

## Install

```bash
yarn add @coordination-network/noir-prover-ffi
```

## Requirements

- Android, `arm64-v8a` only. The package ships no other ABI and has no iOS support.
- The new architecture must be on.
- The app must build for `arm64-v8a` only. Gradle fails the build when the first requested ABI has no library, which is what the default four-ABI build hits. Set `reactNativeArchitectures=arm64-v8a` in `gradle.properties`, or in an Expo app:

```json
["expo-build-properties", { "android": { "buildArchs": ["arm64-v8a"] } }]
```

## Usage

```ts
import ffi from "@coordination-network/noir-prover-ffi"

const prover = ffi.noir_prover_native
```

Importing the module loads the native library, so an app that wants a load failure to surface as a failed proof rather than a crash at launch should `require` it lazily.

## Licenses

The package is MIT. The Android library statically links third-party code, including Apache-2.0 Barretenberg and MPL-2.0 uniffi; `THIRD_PARTY_LICENSES.md` lists everything it contains.
