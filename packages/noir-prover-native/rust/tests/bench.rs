//! Runs the bench iteration against the real circuit: a cold iteration, then a warm one.
//!
//! Serial for the same reason as `credential.rs`: SRS setup is process-global.

use noir_prover_native::bench_iteration;

const CIRCUIT: &str = "../../zk-artifacts/credential/circuit.json";
const SRS: &str = "../assets/g1-131073.dat";
const OUT: &str = "target/bench-test-proof.json";

fn body(line: &str, prefix: &str) -> serde_json::Value {
    serde_json::from_str(line.strip_prefix(prefix).expect("marker prefix")).expect("marker JSON")
}

#[test]
#[serial_test::serial]
fn a_cold_iteration_loads_and_a_warm_one_only_proves() {
    let cold = bench_iteration(0, CIRCUIT.to_string(), SRS.to_string(), false, OUT.to_string()).expect("cold iteration");
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

    let warm = bench_iteration(1, CIRCUIT.to_string(), SRS.to_string(), false, OUT.to_string()).expect("warm iteration");
    let iter = body(&warm.iter_line, "NOIR_ITER ");
    assert_eq!(iter["phase"], "warm");
    assert_eq!(iter["load_ms"], 0);
    assert!(warm.sizes_line.is_none());
}
