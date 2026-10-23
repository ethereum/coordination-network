//! Proves the real credential circuit end to end through this crate's own API.
//!
//! SRS setup is process-global and first-call-wins in barretenberg 5.x, so these run serially.

use noir_prover_native::{credential_verification_key, init_srs, prove_credential, prove_credential_blocking};

const CIRCUIT: &str = "../../zk-artifacts/credential/circuit.json";
const SRS: &str = "../assets/g1-131073.dat";

fn circuit_hash() -> String {
    let text = std::fs::read_to_string(CIRCUIT).expect("compiled circuit");
    let circuit: serde_json::Value = serde_json::from_str(&text).expect("circuit is JSON");
    circuit["hash"].as_str().expect("circuit has a hash").to_string()
}

fn witness() -> Vec<String> {
    let text = std::fs::read_to_string("tests/credential-witness.json").expect("witness fixture");
    serde_json::from_str(&text).expect("witness fixture is a JSON array of strings")
}

#[test]
#[serial_test::serial]
fn proves_the_credential_circuit() {
    let values = witness();
    assert_eq!(values.len(), 239, "the credential circuit takes 239 flattened witness values");

    let started = std::time::Instant::now();
    init_srs(CIRCUIT.to_string(), SRS.to_string(), circuit_hash()).expect("srs");
    eprintln!("srs init: {:?}", started.elapsed());

    let started = std::time::Instant::now();
    let vk = credential_verification_key(CIRCUIT.to_string(), false).expect("verification key");
    eprintln!("verification key: {:?}", started.elapsed());
    assert!(!vk.is_empty());

    let started = std::time::Instant::now();
    let proof = prove_credential_blocking(CIRCUIT.to_string(), values, vk, false).expect("proof");
    eprintln!("prove: {:?}", started.elapsed());

    // Five declared public parameters plus the two Fields of the public return tuple, which the
    // solver computes. `zk-proof.ts` enforces exactly this count.
    assert_eq!(proof.public_inputs.len(), 7);
    for input in &proof.public_inputs {
        assert_eq!(input.len(), 66, "each public input is 0x plus 32 bytes");
    }
    assert!(proof.proof.starts_with("0x"));
    assert!(proof.proof.len() > 2);

    std::fs::write(
        "target/native-proof.json",
        serde_json::to_string_pretty(&serde_json::json!({
            "proof": proof.proof,
            "publicInputs": proof.public_inputs,
        }))
        .unwrap(),
    )
    .unwrap();
}

/// The FFI export proves on a thread of its own and hands the result back over a channel. This
/// drives that whole path: the blocking core above is what the rest of these tests exercise.
#[test]
#[serial_test::serial]
fn the_exported_prover_returns_the_proof_across_its_channel() {
    let values = witness();
    init_srs(CIRCUIT.to_string(), SRS.to_string(), circuit_hash()).expect("srs");
    let vk = credential_verification_key(CIRCUIT.to_string(), false).expect("verification key");

    let proving = prove_credential(CIRCUIT.to_string(), values, vk, false);
    let proof = futures::executor::block_on(proving).expect("proof");

    assert_eq!(proof.public_inputs.len(), 7);
    assert!(proof.proof.starts_with("0x"));
    assert!(proof.proof.len() > 2);
}

#[test]
#[serial_test::serial]
fn rejects_an_empty_witness_value() {
    let mut values = witness();
    values[0] = String::new();
    init_srs(CIRCUIT.to_string(), SRS.to_string(), circuit_hash()).expect("srs");
    let error = prove_credential_blocking(CIRCUIT.to_string(), values, vec![], false).unwrap_err();
    assert!(format!("{error}").contains("witness[0]"), "got: {error}");
}

#[test]
#[serial_test::serial]
fn refuses_a_circuit_the_caller_was_not_built_against() {
    let error = init_srs(CIRCUIT.to_string(), SRS.to_string(), "1234".to_string()).unwrap_err();
    let message = format!("{error}");
    assert!(message.contains(&circuit_hash()), "got: {message}");
    assert!(message.contains("1234"), "got: {message}");
    assert!(message.contains("sync-assets.sh"), "got: {message}");
}

#[test]
#[serial_test::serial]
fn reports_a_missing_circuit_rather_than_panicking() {
    let error = init_srs("./no-such-circuit.json".to_string(), SRS.to_string(), circuit_hash()).unwrap_err();
    assert!(format!("{error}").contains("cannot read"), "got: {error}");
}
