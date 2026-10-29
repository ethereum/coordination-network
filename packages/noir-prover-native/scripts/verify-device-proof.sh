#!/usr/bin/env bash
# Verifies the proofs pulled from the device. `prove.proof` goes to the SDK verifier and the
# committed credential circuit. Any other <step>.proof goes to verify-bench-proof.ts with the
# circuit android-bench/circuits/<step>.json. Takes the pulled out/ directory, as the runner passes
# it, or one proof file.
#
#   adb pull /sdcard/zkbench/org.coordination.nbench/out ./out
#   scripts/verify-device-proof.sh ./out
#
# Exits non-zero when no proof is found or any is rejected.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <out dir | <step>.proof>" >&2; exit 2; }
TARGET="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

# Absolute before the cd into $ROOT below, so a relative out dir means the caller's.
if [ -d "$TARGET" ]; then
    PROOFS=()
    for f in "$TARGET"/*.proof; do
        [ -f "$f" ] && PROOFS+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")")
    done
    [ ${#PROOFS[@]} -gt 0 ] || { echo "no *.proof in $TARGET" >&2; exit 1; }
else
    [ -f "$TARGET" ] || { echo "no proof at $TARGET" >&2; exit 1; }
    PROOFS=("$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")")
fi

cd "$ROOT"
failed=0
for path in "${PROOFS[@]}"; do
    step="$(basename "$path" .proof)"
    echo "verifying $step"
    case "$step" in
        prove) cmd=(node_modules/.bin/tsx packages/noir-prover-native/scripts/verify-native-proof.ts "$path") ;;
        sha256 | ecdsa)
            expected="true"
            if [ "$step" = sha256 ]; then
                # The message is the first input_len values of the witness the device proved.
                expected="$(python3 -c '
import hashlib, json, sys
w = json.load(open(sys.argv[1]))
print(hashlib.sha256(bytes(int(v) for v in w[: int(w[-1])])).hexdigest())' "$HERE/../android-bench/circuits/sha256-witness.json")"
            fi
            cmd=(node_modules/.bin/tsx packages/noir-prover-native/scripts/verify-bench-proof.ts
                "$HERE/../android-bench/circuits/$step.json" "$path" "$expected")
            ;;
        *) echo "no verifier for step $step" >&2; failed=1; continue ;;
    esac
    "${cmd[@]}" || failed=1
done
exit $failed
