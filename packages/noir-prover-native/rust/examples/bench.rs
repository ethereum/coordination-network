//! macOS counterpart of the Android bench: prints the same `NOIR_*` markers to stdout.
//!
//!   cargo run --release --example bench -- [warm_iters] [low_memory]
//!
//! `ru_maxrss` cannot be reset, so every ITER line here carries `"rss_per_step": false`.

use noir_prover_native::{bench_device_line, bench_done_line, bench_error_line, bench_iteration};

const CIRCUIT: &str = "../../zk-artifacts/credential/circuit.json";
const SRS: &str = "../assets/g1-131073.dat";

fn main() {
    let mut args = std::env::args().skip(1);
    let warm_iters: u32 = args.next().map_or(2, |a| a.parse().expect("warm_iters is a number"));
    let low_memory_mode = args.next().is_some_and(|a| a == "low_memory");

    println!("{}", bench_device_line());

    let (mut ok, mut errors) = (0, 0);
    for iter in 0..=warm_iters {
        match bench_iteration(iter, CIRCUIT.to_string(), SRS.to_string(), low_memory_mode) {
            Ok(done) => {
                println!("{}", done.iter_line);
                if let Some(sizes) = done.sizes_line {
                    println!("{sizes}");
                }
                ok += 1;
            }
            Err(e) => {
                println!("{}", bench_error_line("prove".to_string(), iter, e.to_string()));
                errors += 1;
            }
        }
    }
    println!("{}", bench_done_line(ok, errors));
}
