#!/usr/bin/env bash
# Fetches the G1 prefix of Aztec's structured reference string that a circuit needs.
#
#   scripts/fetch-srs.sh [points]    131073 (default, the credential circuit), or 262145 for SHA-256
#
# barretenberg will range-request this itself when given no path, but it has no cache, so every
# process start pays the download (23 s, measured). A local file costs 190 ms.
set -euo pipefail

# 110_573 gates -> dyadic 2^17 -> 131_073 G1 points at 64 bytes each. 2^18 + 1 = 262_145 covers
# the SHA-256 circuit.
POINTS="${1:-131073}"
case "$POINTS" in
    ''|*[!0-9]*) echo "usage: $0 [points]" >&2; exit 2 ;;
esac
BYTES=$((POINTS * 64))
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/assets/g1-${POINTS}.dat"

if [ -f "$DEST" ] && [ "$(wc -c < "$DEST")" -eq "$BYTES" ]; then
    echo "srs already present: $DEST"
    exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "fetching ${BYTES} bytes of g1.dat -> $DEST"
curl --fail --silent --show-error \
    --header "Range: bytes=0-$((BYTES - 1))" \
    --output "$DEST" \
    https://crs.aztec.network/g1.dat

actual="$(wc -c < "$DEST")"
if [ "$actual" -ne "$BYTES" ]; then
    rm -f "$DEST"
    echo "expected ${BYTES} bytes, got ${actual}" >&2
    exit 1
fi
echo "ok"
