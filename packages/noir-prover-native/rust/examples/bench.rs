//! macOS counterpart of the Android bench: prints the same `NOIR_*` markers to stdout.
//!
//!   cargo run --release --features bench --example bench -- [warm_iters] [low_memory|-] [prove|sha256|ecdsa]
//!
//! One step per process: barretenberg keeps the first SRS it initializes.
//!
//! `ru_maxrss` cannot be reset, so every ITER line here carries `"rss_per_step": false`.

use noir_prover_native::{bench_device_line, bench_done_line, bench_error_line, bench_iteration};

/// `(circuit, srs, witness)` per step. An empty witness is the credential witness compiled in.
fn artifacts(step: &str) -> (&'static str, &'static str, &'static str) {
    match step {
        "prove" => ("../../zk-artifacts/credential/circuit.json", "../assets/g1-131073.dat", ""),
        "sha256" => (
            "../android-bench/circuits/sha256.json",
            "../assets/g1-262145.dat",
            "../android-bench/circuits/sha256-witness.json",
        ),
        "ecdsa" => (
            "../android-bench/circuits/ecdsa.json",
            "../assets/g1-262145.dat",
            "../android-bench/circuits/ecdsa-witness.json",
        ),
        other => panic!("unknown step {other}: expected prove, sha256 or ecdsa"),
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let warm_iters: u32 = args.next().map_or(2, |a| a.parse().expect("warm_iters is a number"));
    let low_memory_mode = args.next().is_some_and(|a| a == "low_memory");
    let step = args.next().unwrap_or_else(|| "prove".to_string());
    let (circuit, srs, witness) = artifacts(&step);
    let proof_out = format!("target/bench-{step}-proof.json");

    println!("{}", bench_device_line());

    let (mut ok, mut errors) = (0, 0);
    for iter in 0..=warm_iters {
        match bench_iteration(
            iter,
            step.clone(),
            circuit.to_string(),
            srs.to_string(),
            witness.to_string(),
            low_memory_mode,
            proof_out.clone(),
        ) {
            Ok(done) => {
                println!("{}", done.iter_line);
                if let Some(sizes) = done.sizes_line {
                    println!("{sizes}");
                }
                ok += 1;
                if let Some(line) = done.write_error_line {
                    println!("{line}");
                    errors += 1;
                }
            }
            Err(e) => {
                println!("{}", bench_error_line(step.clone(), iter, e.to_string()));
                errors += 1;
                // A failed cold iteration leaves nothing for the warm ones to reuse.
                if iter == 0 {
                    break;
                }
            }
        }
    }
    println!("{}", bench_done_line(ok, errors));
}
