//! Native UltraHonk prover for the coordination network's credential presentation circuit.
//!
//! Exists because Hermes has no `WebAssembly`, so `@aztec/bb.js` cannot run in React Native. The
//! proofs this produces are verified by the unchanged SDK verifier on the member server.

#[macro_use]
mod stubs;

mod error;
pub use error::MoproError;

// Initializes the shared UniFFI scaffolding and defines the `MoproError` enum.
#[cfg(not(target_arch = "wasm32"))]
mopro_ffi::app!();

mod bench;
mod credential;
pub use bench::{
    bench_current_rss_kb, bench_device_line, bench_done_line, bench_error_line, bench_iteration,
    bench_mem_available_kb, bench_peak_rss_kb, bench_reset_peak_rss, bench_stage_file, BenchIteration,
};
pub use credential::{
    credential_verification_key, init_srs, prove_credential, prove_credential_blocking, CredentialProof,
};

// mopro's `app!()` expects every adapter to be declared, whether or not it is used.
circom_stub!();
halo2_stub!();
gnark_stub!();
