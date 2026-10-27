#!/usr/bin/env bash
# Verifies a proof pulled from the device against the SDK verifier and the committed circuit.
# Takes the pulled out/ directory, as the runner passes it, or the proof file itself.
#
#   adb pull /sdcard/zkbench/org.coordination.nbench/out ./out
#   scripts/verify-device-proof.sh ./out
#
# Exits non-zero when the proof is missing or rejected.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <out dir | prove.proof>" >&2; exit 2; }
TARGET="$1"
[ -d "$TARGET" ] && TARGET="$TARGET/prove.proof"
[ -f "$TARGET" ] || { echo "no proof at $TARGET" >&2; exit 1; }
PROOF="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$ROOT"
node_modules/.bin/tsx packages/noir-prover-native/scripts/verify-native-proof.ts "$PROOF"
