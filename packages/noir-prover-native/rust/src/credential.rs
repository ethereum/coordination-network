//! Native UltraHonk proving for the credential circuit.
//!
//! Proofs are poseidon2-oracle, which is what `@aztec/bb.js` verifies by default; nothing in the
//! SDK passes proof options to `verifyZkPresentationProof`, so a keccak proof would be rejected.

use futures_channel::oneshot;
use noir_rs::{
    barretenberg::{
        prove::prove_ultra_honk, srs::setup_srs_from_bytecode, verify::get_ultra_honk_verification_key,
    },
    witness::from_vec_str_to_witness_map,
};

use crate::MoproError;

/// A proof already split the way `bb.js`'s `ProofData` expects: public inputs out of the proof
/// bytes, not prepended to them. Getting this wrong yields a `PROOF_INVALID` that looks like a
/// cryptographic failure, so the split lives here rather than in TypeScript.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CredentialProof {
    /// `0x`-prefixed hex of the proof fields alone.
    pub proof: String,
    /// One `0x`-prefixed 32-byte field per public input, in circuit order.
    pub public_inputs: Vec<String>,
}

/// Reads the SRS once for this process. Barretenberg 5.x makes SRS setup global and first-call-wins,
/// so a long-lived app must call this before its first proof, with the largest circuit it will prove.
///
/// `srs_path` must be a `g1.dat` prefix of at least `131_073 * 64` bytes for this circuit. Passing
/// `None` would make barretenberg range-request the SRS over HTTP on every process start, with no
/// cache — 23 s where a bundled file costs 190 ms.
///
/// `expected_hash` is the artifact hash the caller flattens its witness against. An app ships the
/// ABI and the artifact as two files, so they can drift apart; a witness ordered by one and proved
/// against the other produces a proof that fails verification with nothing to point at. Refusing
/// here names both hashes instead.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn init_srs(circuit_path: String, srs_path: String, expected_hash: String) -> Result<u32, MoproError> {
    let circuit = circuit_json(&circuit_path)?;
    let hash = circuit["hash"]
        .as_str()
        .ok_or_else(|| MoproError::NoirError(format!("{circuit_path} has no hash field")))?;
    if hash != expected_hash {
        return Err(MoproError::NoirError(format!(
            "{circuit_path} has hash {hash}, but the caller was built against {expected_hash}; \
             re-run apps/user-app/scripts/sync-assets.sh"
        )));
    }

    let bytecode = bytecode_of(&circuit, &circuit_path)?;
    setup_srs_from_bytecode(bytecode.as_str(), Some(srs_path.as_str()), false)
        .map_err(|e| MoproError::NoirError(format!("srs setup failed: {e}")))
}

/// Computes the verification key. Barretenberg recomputes it inside every proof unless one is
/// supplied, so compute this once on first launch and cache it in app storage.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn credential_verification_key(
    circuit_path: String,
    low_memory_mode: bool,
) -> Result<Vec<u8>, MoproError> {
    let circuit = circuit_json(&circuit_path)?;
    let bytecode = bytecode_of(&circuit, &circuit_path)?;
    get_ultra_honk_verification_key(bytecode.as_str(), low_memory_mode, None)
        .map_err(|e| MoproError::NoirError(format!("verification key failed: {e}")))
}

/// Proves the credential presentation on a thread of its own, leaving the caller's thread — the JS
/// thread on a phone — free to keep painting while it runs.
///
/// `witness` is the circuit's parameters flattened depth-first in ABI order — 239 values for this
/// circuit — as produced by `zkPresentationInputsToWitness` in `@coordination-network/credential`.
/// Pass an empty `vk` to recompute it, at roughly a second's cost.
///
/// The 64 MiB stack is barretenberg's: it recurses far deeper than a thread's 2 MiB default, and
/// the JS thread this used to run on is itself generously sized.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub async fn prove_credential(
    circuit_path: String,
    witness: Vec<String>,
    vk: Vec<u8>,
    low_memory_mode: bool,
) -> Result<CredentialProof, MoproError> {
    let (sender, receiver) = oneshot::channel();

    // `.cargo/config.toml` builds std with `panic_abort`, so a panic in here takes the process down
    // exactly as it did when proving ran on the JS thread. There is nothing to catch either way.
    std::thread::Builder::new()
        .name("noir-prover".to_string())
        .stack_size(64 << 20)
        .spawn(move || {
            let _ = sender.send(prove_credential_blocking(circuit_path, witness, vk, low_memory_mode));
        })
        .map_err(|e| MoproError::NoirError(format!("cannot start the prover thread: {e}")))?;

    receiver
        .await
        .map_err(|_| MoproError::NoirError("the prover thread ended without a result".to_string()))?
}

/// The proving itself, on whatever thread calls it. Not part of the FFI surface: `prove_credential`
/// is what an app calls, and this is what its thread and this crate's tests run.
pub fn prove_credential_blocking(
    circuit_path: String,
    witness: Vec<String>,
    vk: Vec<u8>,
    low_memory_mode: bool,
) -> Result<CredentialProof, MoproError> {
    let circuit = circuit_json(&circuit_path)?;
    let bytecode = bytecode_of(&circuit, &circuit_path)?;

    // `from_vec_str_to_witness_map` turns anything it cannot parse into a silent zero, so reject
    // malformed values here instead of proving something that was never the caller's input.
    let values: Vec<&str> = witness.iter().map(String::as_str).collect();
    for (index, value) in values.iter().enumerate() {
        if value.is_empty() {
            return Err(MoproError::NoirError(format!("witness[{index}] is empty")));
        }
    }
    let witness_map = from_vec_str_to_witness_map(values)
        .map_err(|e| MoproError::NoirError(format!("witness rejected: {e}")))?;

    let flat = prove_ultra_honk(bytecode.as_str(), witness_map, vk, low_memory_mode, None)
        .map_err(|e| MoproError::NoirError(format!("proving failed: {e}")))?;

    split_proof(&flat)
}

/// `prove_ultra_honk` returns `[u32 BE count][count * 32-byte public inputs][proof fields]`.
fn split_proof(flat: &[u8]) -> Result<CredentialProof, MoproError> {
    const FIELD: usize = 32;

    let header: [u8; 4] = flat
        .get(..4)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| MoproError::NoirError("proof is shorter than its length prefix".to_string()))?;
    let count = u32::from_be_bytes(header) as usize;

    let end = 4 + count * FIELD;
    let public_bytes = flat
        .get(4..end)
        .ok_or_else(|| MoproError::NoirError(format!("proof declares {count} public inputs it does not carry")))?;

    Ok(CredentialProof {
        proof: format!("0x{}", hex::encode(&flat[end..])),
        public_inputs: public_bytes
            .chunks(FIELD)
            .map(|chunk| format!("0x{}", hex::encode(chunk)))
            .collect(),
    })
}

pub(crate) fn circuit_json(circuit_path: &str) -> Result<serde_json::Value, MoproError> {
    let text = std::fs::read_to_string(circuit_path)
        .map_err(|e| MoproError::NoirError(format!("cannot read {circuit_path}: {e}")))?;
    serde_json::from_str(&text)
        .map_err(|e| MoproError::NoirError(format!("{circuit_path} is not valid JSON: {e}")))
}

fn bytecode_of(circuit: &serde_json::Value, circuit_path: &str) -> Result<String, MoproError> {
    circuit["bytecode"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| MoproError::NoirError(format!("{circuit_path} has no bytecode field")))
}
