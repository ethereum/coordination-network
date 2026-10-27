#!/usr/bin/env bash
# Verifies a proof pulled from the device against the SDK verifier and the committed circuit.
#
#   adb pull /sdcard/Android/data/org.coordination.nbench/files/out ./out
#   scripts/verify-device-proof.sh out/prove.proof
#
# Exits non-zero when the proof is rejected.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <prove.proof>" >&2; exit 2; }
PROOF="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$ROOT"
node_modules/.bin/tsx packages/noir-prover-native/scripts/verify-native-proof.ts "$PROOF"
