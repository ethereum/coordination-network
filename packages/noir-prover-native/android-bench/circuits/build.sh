#!/usr/bin/env bash
# Compiles CSP's SHA-256 and ECDSA P-256 circuits with the repo's nargo (beta.22), writes the
# artifacts next to this script as sha256.json and ecdsa.json, and writes the flat witnesses the
# bench harness proves with. Needs nargo 1.0.0-beta.22 and network on the first run, for the
# sha256 library dependency.
#
# Sources are copied unchanged from csp-benchmarks/barretenberg/circuits (hash/sha256, ecdsa).
# The compiled hash is turned into a string, as in zk-artifacts, because init_srs reads it with
# as_str.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

nargo --version | head -1 | grep -q "1.0.0-beta.22" || { echo "need nargo 1.0.0-beta.22" >&2; exit 1; }

# SHA-256 over a fixed 2 KB message: byte i is i mod 256.
python3 - <<'PY'
import json
message = [i % 256 for i in range(2048)]
with open("sha256/Prover.toml", "w") as f:
    f.write(f"input = {json.dumps(message)}\ninput_len = 2048\n")
PY

for circuit in sha256 ecdsa; do
    (cd "$circuit" && nargo compile && nargo execute >/dev/null)
    python3 - "$circuit" <<'PY'
import json, sys
name = sys.argv[1]
artifact = json.load(open(f"{name}/target/{name}.json"))
artifact["hash"] = str(artifact["hash"])
with open(f"{name}.json", "w") as f:
    json.dump(artifact, f, separators=(",", ":"))
PY
    python3 flatten_witness.py "$circuit/target/$circuit.json" "$circuit/Prover.toml" > "$circuit-witness.json"
done
