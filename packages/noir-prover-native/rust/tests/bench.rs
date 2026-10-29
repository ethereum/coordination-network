//! Runs the bench iteration against the real circuit: a cold iteration, then a warm one.
//!
//! Serial for the same reason as `credential.rs`: SRS setup is process-global.

use noir_prover_native::bench_iteration;

const CIRCUIT: &str = "../../zk-artifacts/credential/circuit.json";
const SRS: &str = "../assets/g1-131073.dat";
const WITNESS: &str = "tests/credential-witness.json";
const OUT: &str = "target/bench-test-proof.json";

fn body(line: &str, prefix: &str) -> serde_json::Value {
    serde_json::from_str(line.strip_prefix(prefix).expect("marker prefix")).expect("marker JSON")
}

#[test]
#[serial_test::serial]
fn a_cold_iteration_loads_and_a_warm_one_only_proves() {
    let cold = bench_iteration(0, "prove".to_string(), CIRCUIT.to_string(), SRS.to_string(), String::new(), false, OUT.to_string()).expect("cold iteration");
    let iter = body(&cold.iter_line, "NOIR_ITER ");
    assert_eq!(iter["phase"], "cold");
    assert!(iter["load_ms"].as_u64().unwrap() > 0);
    assert!(iter["prove_ms"].as_u64().unwrap() > 0);
    assert!(iter["total_ms"].as_u64().unwrap() >= iter["prove_ms"].as_u64().unwrap());

    let sizes = body(&cold.sizes_line.expect("sizes after the first success"), "NOIR_SIZES ");
    assert!(sizes["proof_bytes"].as_u64().unwrap() > 0);
    assert!(sizes["vk_bytes"].as_u64().unwrap() > 0);
    assert_eq!(sizes["srs_bytes"].as_u64().unwrap(), std::fs::metadata(SRS).unwrap().len());
    assert_eq!(sizes["circuit_bytes"].as_u64().unwrap(), std::fs::metadata(CIRCUIT).unwrap().len());

    let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(OUT).unwrap()).unwrap();
    assert!(written["proof"].as_str().unwrap().starts_with("0x"));
    assert_eq!(written["publicInputs"].as_array().unwrap().len(), 7);

    let warm = bench_iteration(1, "prove".to_string(), CIRCUIT.to_string(), SRS.to_string(), String::new(), false, OUT.to_string()).expect("warm iteration");
    let iter = body(&warm.iter_line, "NOIR_ITER ");
    assert_eq!(iter["phase"], "warm");
    assert_eq!(iter["load_ms"], 0);
    assert!(warm.sizes_line.is_none());
}

#[test]
#[serial_test::serial]
fn an_unwritable_proof_path_keeps_the_timed_proof() {
    let done = bench_iteration(
        0,
        "prove".to_string(),
        CIRCUIT.to_string(),
        SRS.to_string(),
        String::new(),
        false,
        "/no-such-dir/prove.proof".to_string(),
    )
        .expect("the proof itself succeeded");
    assert!(done.iter_line.starts_with("NOIR_ITER "));
    assert!(done.sizes_line.is_some());
    let error = body(&done.write_error_line.expect("the write failure is reported"), "NOIR_ERROR ");
    assert_eq!(error["step"], "prove");
    assert!(error["error"].as_str().unwrap().contains("/no-such-dir/prove.proof"));
}

#[test]
#[serial_test::serial]
fn a_witness_file_and_a_step_name_reach_the_lines() {
    let done = bench_iteration(
        0,
        "custom".to_string(),
        CIRCUIT.to_string(),
        SRS.to_string(),
        WITNESS.to_string(),
        false,
        OUT.to_string(),
    )
    .expect("the credential witness file proves like the compiled-in one");
    assert_eq!(body(&done.iter_line, "NOIR_ITER ")["step"], "custom");
    assert_eq!(body(&done.sizes_line.unwrap(), "NOIR_SIZES ")["step"], "custom");
}

#[test]
#[serial_test::serial]
fn a_missing_witness_file_fails_before_loading() {
    let error = bench_iteration(
        0,
        "prove".to_string(),
        CIRCUIT.to_string(),
        SRS.to_string(),
        "/nonexistent/witness.json".to_string(),
        false,
        OUT.to_string(),
    )
    .unwrap_err();
    assert!(format!("{error}").contains("cannot read the witness"), "got: {error}");
}

#[test]
#[serial_test::serial]
fn a_step_other_than_prove_needs_a_witness_file() {
    let error = bench_iteration(
        0,
        "sha256".to_string(),
        CIRCUIT.to_string(),
        SRS.to_string(),
        String::new(),
        false,
        OUT.to_string(),
    )
    .unwrap_err();
    assert!(format!("{error}").contains("step sha256 has no witness_path"), "got: {error}");
}
