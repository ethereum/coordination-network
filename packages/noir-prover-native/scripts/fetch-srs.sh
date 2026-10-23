#!/usr/bin/env bash
# Fetches the G1 prefix of Aztec's structured reference string that the credential circuit needs.
#
# barretenberg will range-request this itself when given no path, but it has no cache, so every
# process start pays the download (23 s, measured). A local file costs 190 ms.
set -euo pipefail

# 110_573 gates -> dyadic 2^17 -> 131_073 G1 points at 64 bytes each.
POINTS=131073
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
