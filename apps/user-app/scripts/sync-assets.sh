#!/usr/bin/env bash
# Copies the runtime inputs the native prover needs into the app.
#
# The compiled circuit is split in two on purpose. Rust needs the whole 1.9 MB artifact as a file,
# so it ships as a binary asset; JavaScript needs only the 5 KB ABI, to flatten the witness, so that
# goes in as a module rather than inlining the bytecode into the JS bundle.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$APP/../.." && pwd)"

# Read @coordination-network/zk-artifacts' committed file by path: the package resolves it through
# import.meta.url, which this script has no runtime to evaluate.
CIRCUIT="$ROOT/packages/zk-artifacts/credential/circuit.json"
SRS="$ROOT/packages/noir-prover-native/assets/g1-131073.dat"

[ -f "$SRS" ] || "$ROOT/packages/noir-prover-native/scripts/fetch-srs.sh"

mkdir -p "$APP/assets" "$APP/src/generated"
cp "$CIRCUIT" "$APP/assets/credential.noir"
cp "$SRS" "$APP/assets/g1-131073.dat"
node -e '
const { readFileSync, writeFileSync } = require("fs")
const circuit = JSON.parse(readFileSync(process.argv[1], "utf8"))
writeFileSync(process.argv[2], JSON.stringify({ abi: circuit.abi, hash: circuit.hash }, null, 2) + "\n")
' "$CIRCUIT" "$APP/src/generated/credential-abi.json"

ls -la "$APP/assets" "$APP/src/generated"
