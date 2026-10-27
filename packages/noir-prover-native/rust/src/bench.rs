//! Device bench harness for the credential proof: probes, one-iteration runner and the `NOIR_*`
//! marker lines the host runner scrapes from logcat. The Android app and `examples/bench.rs` both
//! drive it, so the two print the same lines.

use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};

use crate::credential::circuit_json;
use crate::{credential_verification_key, init_srs, prove_credential_blocking, MoproError};

/// The runner drops anything longer than this, so a builder never emits it.
const MAX_LINE_BYTES: usize = 900;

const STEP: &str = "prove";

/// Same 239 values `tests/credential.rs` proves with.
const WITNESS: &str = include_str!("../tests/credential-witness.json");

/// What iteration 0 loads, kept for the warm iterations. The SRS itself is process-global in
/// barretenberg, so only the verification key lives here.
struct Loaded {
    vk: Vec<u8>,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

/// One iteration's marker lines. `sizes` is set on the first success only.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct BenchIteration {
    pub iter_line: String,
    pub sizes_line: Option<String>,
    /// Set when the proof succeeded but `proof_out_path` could not be written: the timed proof
    /// stands, and the caller logs this line after the others.
    pub write_error_line: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

/// Parses a `Key:   12345 kB` line out of `/proc/self/status` or `/proc/meminfo`.
fn parse_status_kb(text: &str, key: &str) -> Option<u64> {
    text.lines()
        .find_map(|l| l.strip_prefix(key))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse().ok())
}

fn parse_vmhwm_kb(status: &str) -> Option<u64> {
    parse_status_kb(status, "VmHWM:")
}

fn parse_vmrss_kb(status: &str) -> Option<u64> {
    parse_status_kb(status, "VmRSS:")
}

fn parse_mem_available_kb(meminfo: &str) -> Option<u64> {
    parse_status_kb(meminfo, "MemAvailable:")
}

/// Cores above the lowest frequency tier are big. With one tier, or no readable frequency, every
/// core counts as big; an unreadable core in a mixed layout does not.
fn classify_big_cores(max_freqs_khz: &[Option<u64>]) -> Vec<usize> {
    let lowest = max_freqs_khz.iter().flatten().min();
    let highest = max_freqs_khz.iter().flatten().max();
    if lowest == highest {
        return (0..max_freqs_khz.len()).collect();
    }
    max_freqs_khz
        .iter()
        .enumerate()
        .filter(|(_, f)| f.is_some_and(|f| Some(&f) > lowest))
        .map(|(i, _)| i)
        .collect()
}

fn read_cpu_max_freqs_khz() -> Vec<Option<u64>> {
    (0..)
        .map(|n| format!("/sys/devices/system/cpu/cpu{n}"))
        .take_while(|dir| std::path::Path::new(dir).exists())
        .map(|dir| {
            std::fs::read_to_string(format!("{dir}/cpufreq/cpuinfo_max_freq"))
                .ok()
                .and_then(|v| v.trim().parse().ok())
        })
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_proc(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Resets VmHWM to the current RSS. False where the kernel refuses or there is no `/proc`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_reset_peak_rss() -> bool {
    cfg!(any(target_os = "linux", target_os = "android"))
        && std::fs::write("/proc/self/clear_refs", "5").is_ok()
}

/// High-water RSS in KiB since the last reset. On macOS this is `ru_maxrss`, which never resets.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_peak_rss_kb() -> u64 {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        read_proc("/proc/self/status").and_then(|s| parse_vmhwm_kb(&s)).unwrap_or(0)
    }
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    {
        // SAFETY: rusage is plain data and getrusage fills the zeroed local.
        let max_rss = unsafe {
            let mut usage: libc::rusage = std::mem::zeroed();
            libc::getrusage(libc::RUSAGE_SELF, &mut usage);
            usage.ru_maxrss as u64
        };
        // Bytes on Apple platforms, KiB elsewhere.
        if cfg!(target_vendor = "apple") {
            max_rss / 1024
        } else {
            max_rss
        }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// Current RSS in KiB; `ps` off Linux.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_current_rss_kb() -> u64 {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        read_proc("/proc/self/status").and_then(|s| parse_vmrss_kb(&s)).unwrap_or(0)
    }
    #[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
    {
        // No cheap in-process read without Mach bindings, and a bench calls this twice per iteration.
        std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(0)
    }
    #[cfg(not(unix))]
    {
        0
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_mem_available_kb() -> u64 {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        read_proc("/proc/meminfo").and_then(|s| parse_mem_available_kb(&s)).unwrap_or(0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        0
    }
}

fn mem_total_kb() -> u64 {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        read_proc("/proc/meminfo").and_then(|s| parse_status_kb(&s, "MemTotal:")).unwrap_or(0)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        0
    }
}

#[cfg(target_os = "android")]
fn android_prop(name: &str) -> String {
    std::process::Command::new("getprop")
        .arg(name)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(not(target_os = "android"))]
fn android_prop(_name: &str) -> String {
    String::new()
}

/// Drops `path` from the page cache. A failure only leaves the file cached, so it is ignored.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn drop_page_cache(path: &std::path::Path) {
    use std::os::fd::AsRawFd;
    if let Ok(f) = std::fs::File::open(path) {
        // SAFETY: the fd is valid for the call; offset 0 and length 0 mean the whole file.
        unsafe { libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn drop_page_cache(_path: &std::path::Path) {}

/// Copies `src` to `dest` (creating parent directories), flushes it and drops both from the page
/// cache, so the next load reads from storage rather than RAM. Returns the bytes copied. Pushed
/// files sit on emulated external storage while an app keeps its keys in private storage, so the
/// bench stages them there, untimed, before the cold iteration. Ported from OpenAC's `stage_file`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_stage_file(src: String, dest: String) -> Result<u64, MoproError> {
    let io = |what: &str, path: &str, e: std::io::Error| MoproError::NoirError(format!("{what} {path}: {e}"));
    let dest_path = std::path::Path::new(&dest);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io("cannot create the directory of", &dest, e))?;
    }
    let mut input = std::fs::File::open(&src).map_err(|e| io("cannot open", &src, e))?;
    let mut output = std::fs::File::create(dest_path).map_err(|e| io("cannot create", &dest, e))?;
    let bytes = std::io::copy(&mut input, &mut output).map_err(|e| io("cannot copy to", &dest, e))?;
    output.sync_all().map_err(|e| io("cannot flush", &dest, e))?;
    drop_page_cache(std::path::Path::new(&src));
    drop_page_cache(dest_path);
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------
// Marker lines
// ---------------------------------------------------------------------------------------------

/// `<kind> <compact json>` behind the `NOIR_` prefix. Panics on an oversize line: every field
/// is bounded except the error text, which `error_line` truncates first.
fn marker(kind: &str, body: Value) -> String {
    let line = format!("NOIR_{kind} {body}");
    assert!(line.len() < MAX_LINE_BYTES, "{kind} marker is {} bytes", line.len());
    line
}

/// The first `max` bytes of `s`, cut on a char boundary.
fn truncate(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[allow(clippy::too_many_arguments)]
fn device_line(
    model: &str,
    manufacturer: &str,
    soc_model: &str,
    soc_manufacturer: &str,
    sdk: &str,
    mem_total_kb: u64,
    mem_available_kb: u64,
    freqs: &[Option<u64>],
    threads: usize,
) -> String {
    marker(
        "DEVICE",
        json!({
            "model": model,
            "manufacturer": manufacturer,
            "soc_model": soc_model,
            "soc_manufacturer": soc_manufacturer,
            "sdk": sdk,
            "mem_total_kb": mem_total_kb,
            "mem_available_kb": mem_available_kb,
            "cpu_max_freq_khz": freqs,
            "big_cores": classify_big_cores(freqs),
            "threads": threads,
        }),
    )
}

/// What one iteration measured. Cold iterations also carry the load breakdown.
struct IterTimes {
    iter: u32,
    cold: bool,
    load_ms: u64,
    prove_ms: u64,
    total_ms: u64,
    base_rss_kb: u64,
    peak_rss_kb: u64,
    mem_available_kb_before: u64,
    rss_per_step: bool,
    low_memory_mode: bool,
    /// `(srs_ms, vk_ms)`, cold only. Each includes the circuit read and parse its production call
    /// does on its own.
    load_parts: Option<(u64, u64)>,
}

fn iter_line(t: &IterTimes) -> String {
    let mut body = json!({
        "step": STEP,
        "iter": t.iter,
        "phase": if t.cold { "cold" } else { "warm" },
        "load_ms": t.load_ms,
        "prove_ms": t.prove_ms,
        "total_ms": t.total_ms,
        "base_rss_kb": t.base_rss_kb,
        "peak_rss_kb": t.peak_rss_kb,
        "mem_available_kb_before": t.mem_available_kb_before,
        "low_memory_mode": t.low_memory_mode,
    });
    if !t.rss_per_step {
        body["rss_per_step"] = json!(false);
    }
    if let Some((srs, vk)) = t.load_parts {
        body["srs_ms"] = json!(srs);
        body["vk_ms"] = json!(vk);
    }
    marker("ITER", body)
}

fn sizes_line(proof: u64, circuit: u64, srs: u64, vk: u64) -> String {
    marker(
        "SIZES",
        json!({
            "step": STEP,
            "proof_bytes": proof,
            "circuit_bytes": circuit,
            "srs_bytes": srs,
            "vk_bytes": vk,
        }),
    )
}

/// `step` is capped, and `error` is cut after JSON escaping, so the line always fits: a quote or a
/// control character costs up to six output bytes, and this is the one builder fed arbitrary text.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_error_line(step: String, iter: u32, error: String) -> String {
    let step = truncate(&step, 64);
    let mut error = truncate(&error, MAX_LINE_BYTES);
    loop {
        let line = format!("NOIR_ERROR {}", json!({ "step": step, "iter": iter, "error": error }));
        if line.len() < MAX_LINE_BYTES {
            return line;
        }
        // Every dropped byte removes at least one output byte, so this converges.
        error = truncate(error, error.len().saturating_sub(line.len() - MAX_LINE_BYTES + 1));
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_done_line(ok: u32, errors: u32) -> String {
    marker("DONE", json!({ "ok": ok, "errors": errors }))
}

/// The `NOIR_DEVICE` line. Call once, before any proof.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_device_line() -> String {
    device_line(
        &android_prop("ro.product.model"),
        &android_prop("ro.product.manufacturer"),
        &android_prop("ro.soc.model"),
        &android_prop("ro.soc.manufacturer"),
        &android_prop("ro.build.version.sdk"),
        mem_total_kb(),
        bench_mem_available_kb(),
        &read_cpu_max_freqs_khz(),
        std::thread::available_parallelism().map_or(1, |n| n.get()),
    )
}

// ---------------------------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------------------------

fn ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

fn witness() -> Vec<String> {
    serde_json::from_str(WITNESS).expect("witness fixture is a JSON array of strings")
}

fn proof_bytes(hex: &str) -> u64 {
    (hex.len().saturating_sub(2) / 2) as u64
}

/// Runs iteration `iter` of the credential step and returns its marker lines. Iteration 0 is cold:
/// it reads the circuit, initializes the SRS from `srs_path`, derives the verification key and
/// proves, all timed, with `load_ms` covering everything before the proof. Later iterations
/// prove with the state iteration 0 left behind.
///
/// `prove_ms` is the app's own call, `prove_credential_blocking`, which re-reads `circuit_path`
/// on every proof, so a warm `prove_ms` includes that parse.
///
/// A non-empty `proof_out_path` gets the proof as JSON, `{"proof", "publicInputs"}`, the shape
/// `scripts/verify-native-proof.ts` reads, so a desktop can verify what the device proved. It is
/// written after the timed region and replaced by every success.
///
/// Runs on a 64 MiB stack thread, which barretenberg needs, and blocks until it finishes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn bench_iteration(
    iter: u32,
    circuit_path: String,
    srs_path: String,
    low_memory_mode: bool,
    proof_out_path: String,
) -> Result<BenchIteration, MoproError> {
    std::thread::Builder::new()
        .name("noir-bench".to_string())
        .stack_size(64 << 20)
        .spawn(move || run_iteration(iter, &circuit_path, &srs_path, low_memory_mode, &proof_out_path))
        .map_err(|e| MoproError::NoirError(format!("cannot start the bench thread: {e}")))?
        .join()
        // `.cargo/config.toml` builds std with panic_abort, so a panic ends the process before this
        // join can see it.
        .expect("panic=abort: a panicking bench thread never reaches join")
}

fn run_iteration(
    iter: u32,
    circuit_path: &str,
    srs_path: &str,
    low_memory_mode: bool,
    proof_out_path: &str,
) -> Result<BenchIteration, MoproError> {
    // An app knows its circuit's hash and size without reading the file, so this read is not part of
    // the cold load. It is dropped from the page cache again so `init_srs` still reads from storage.
    let known = if iter == 0 {
        let circuit = circuit_json(circuit_path)?;
        let hash = circuit["hash"].as_str().unwrap_or_default().to_string();
        let bytes = std::fs::metadata(circuit_path)
            .map_err(|e| MoproError::NoirError(format!("cannot stat {circuit_path}: {e}")))?
            .len();
        drop_page_cache(std::path::Path::new(circuit_path));
        Some((hash, bytes))
    } else {
        None
    };

    let mem_available_kb_before = bench_mem_available_kb();
    let rss_per_step = bench_reset_peak_rss();
    let base_rss_kb = bench_current_rss_kb();
    let started = Instant::now();

    let cold = iter == 0;
    let mut load_parts = None;
    let mut load_ms = 0;
    let mut sizes = None;
    // Poisoned only by a panic while locked, which aborts the process first.
    let mut loaded = LOADED.lock().unwrap();

    if let Some((hash, circuit_bytes)) = known {
        let t = Instant::now();
        init_srs(circuit_path.to_string(), srs_path.to_string(), hash)?;
        let srs_ms = ms(t);

        let t = Instant::now();
        let vk = credential_verification_key(circuit_path.to_string(), low_memory_mode)?;
        let vk_ms = ms(t);

        let srs_bytes = std::fs::metadata(srs_path)
            .map_err(|e| MoproError::NoirError(format!("cannot stat {srs_path}: {e}")))?
            .len();
        sizes = Some((circuit_bytes, srs_bytes, vk.len() as u64));
        load_ms = ms(started);
        load_parts = Some((srs_ms, vk_ms));
        *loaded = Some(Loaded { vk });
    }

    let Some(state) = loaded.as_ref() else {
        return Err(MoproError::NoirError(format!("iteration {iter} ran before iteration 0 loaded")));
    };

    let t = Instant::now();
    let proof =
        prove_credential_blocking(circuit_path.to_string(), witness(), state.vk.clone(), low_memory_mode)?;
    let prove_ms = ms(t);

    let times = IterTimes {
        iter,
        cold,
        load_ms,
        prove_ms,
        total_ms: ms(started),
        base_rss_kb,
        peak_rss_kb: bench_peak_rss_kb(),
        mem_available_kb_before,
        rss_per_step,
        low_memory_mode,
        load_parts,
    };
    let write_error_line = (!proof_out_path.is_empty())
        .then(|| {
            let document = json!({ "proof": proof.proof, "publicInputs": proof.public_inputs });
            std::fs::write(proof_out_path, document.to_string())
                .err()
                .map(|e| bench_error_line(STEP.to_string(), iter, format!("cannot write {proof_out_path}: {e}")))
        })
        .flatten();
    let proof_len = proof_bytes(&proof.proof);
    Ok(BenchIteration {
        iter_line: iter_line(&times),
        sizes_line: sizes.map(|(circuit, srs, vk)| sizes_line(proof_len, circuit, srs, vk)),
        write_error_line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_status_and_meminfo() {
        let status = "Name:\tapp\nVmPeak:\t 3000000 kB\nVmHWM:\t 2345678 kB\nVmRSS:\t 1234 kB\n";
        assert_eq!(parse_vmhwm_kb(status), Some(2345678));
        assert_eq!(parse_vmrss_kb(status), Some(1234));
        let meminfo = "MemTotal:        3800000 kB\nMemFree:  100 kB\nMemAvailable:    1900000 kB\n";
        assert_eq!(parse_mem_available_kb(meminfo), Some(1900000));
        assert_eq!(parse_status_kb(meminfo, "MemTotal:"), Some(3800000));
    }

    #[test]
    fn parsers_reject_missing_and_malformed_values() {
        assert_eq!(parse_vmhwm_kb("VmRSS:\t 5 kB\n"), None);
        assert_eq!(parse_vmhwm_kb("VmHWM:\t lots kB\n"), None);
        assert_eq!(parse_mem_available_kb(""), None);
    }

    #[test]
    fn big_cores_are_the_ones_above_the_lowest_tier() {
        let freqs = [Some(1800000), Some(1800000), Some(2400000), Some(2800000), None];
        assert_eq!(classify_big_cores(&freqs), vec![2, 3]);
        assert_eq!(classify_big_cores(&[Some(2000000), Some(2000000)]), vec![0, 1]);
        assert_eq!(classify_big_cores(&[None, None]), vec![0, 1]);
    }

    #[test]
    fn device_line_carries_every_contract_field() {
        let line = device_line("Pixel", "Google", "Tensor", "Google", "34", 8_000_000, 4_000_000, &[Some(1), Some(2)], 8);
        let body: Value = serde_json::from_str(line.strip_prefix("NOIR_DEVICE ").unwrap()).unwrap();
        for key in [
            "model",
            "manufacturer",
            "soc_model",
            "soc_manufacturer",
            "sdk",
            "mem_total_kb",
            "mem_available_kb",
            "cpu_max_freq_khz",
            "big_cores",
            "threads",
        ] {
            assert!(body.get(key).is_some(), "missing {key}");
        }
        assert_eq!(body["big_cores"], json!([1]));
        assert_eq!(body["cpu_max_freq_khz"], json!([1, 2]));
    }

    fn times(cold: bool, rss_per_step: bool) -> IterTimes {
        IterTimes {
            iter: if cold { 0 } else { 3 },
            cold,
            load_ms: if cold { 900 } else { 0 },
            prove_ms: 1200,
            total_ms: 2100,
            base_rss_kb: 90_000,
            peak_rss_kb: 1_500_000,
            mem_available_kb_before: 2_000_000,
            rss_per_step,
            low_memory_mode: false,
            load_parts: cold.then_some((190, 690)),
        }
    }

    #[test]
    fn iter_line_has_the_contract_fields() {
        let line = iter_line(&times(true, true));
        let body: Value = serde_json::from_str(line.strip_prefix("NOIR_ITER ").unwrap()).unwrap();
        assert_eq!(body["phase"], "cold");
        assert_eq!(body["step"], "prove");
        for key in ["iter", "load_ms", "prove_ms", "total_ms", "base_rss_kb", "peak_rss_kb", "mem_available_kb_before"] {
            assert!(body.get(key).is_some(), "missing {key}");
        }
        assert!(body.get("rss_per_step").is_none(), "only a failed reset is flagged");
        assert_eq!(body["srs_ms"], 190);
        assert!(body.get("circuit_ms").is_none());

        let warm: Value =
            serde_json::from_str(iter_line(&times(false, false)).strip_prefix("NOIR_ITER ").unwrap()).unwrap();
        assert_eq!(warm["phase"], "warm");
        assert_eq!(warm["load_ms"], 0);
        assert_eq!(warm["rss_per_step"], false);
        assert!(warm.get("srs_ms").is_none());
    }

    #[test]
    fn sizes_line_names_each_artifact() {
        let body: Value =
            serde_json::from_str(sizes_line(14_000, 2_100_000, 8_400_000, 3_700).strip_prefix("NOIR_SIZES ").unwrap())
                .unwrap();
        assert_eq!(body["proof_bytes"], 14_000);
        assert_eq!(body["circuit_bytes"], 2_100_000);
        assert_eq!(body["srs_bytes"], 8_400_000);
        assert_eq!(body["vk_bytes"], 3_700);
    }

    #[test]
    fn error_line_truncates_to_fit_and_keeps_utf8() {
        let line = bench_error_line("prove".to_string(), 2, "é".repeat(2000));
        assert!(line.len() < MAX_LINE_BYTES, "{} bytes", line.len());
        assert!(line.starts_with("NOIR_ERROR "));
        let body: Value = serde_json::from_str(line.strip_prefix("NOIR_ERROR ").unwrap()).unwrap();
        assert_eq!(body["iter"], 2);
        assert!(body["error"].as_str().unwrap().starts_with('é'));
    }

    #[test]
    fn error_line_stays_under_the_limit_after_json_escaping() {
        // Every one of these escapes to two or six bytes, so truncating before serializing overflows.
        let nasty = "\"\\\n\t\u{1}\u{7f}é\"".repeat(300);
        for step in ["prove", &nasty] {
            let line = bench_error_line(step.to_string(), u32::MAX, nasty.clone());
            assert!(line.len() < MAX_LINE_BYTES, "{} bytes", line.len());
            let body: Value = serde_json::from_str(line.strip_prefix("NOIR_ERROR ").unwrap()).unwrap();
            assert_eq!(body["iter"], u32::MAX);
            assert!(nasty.starts_with(body["error"].as_str().unwrap()), "error keeps a prefix of the input");
        }
    }

    #[test]
    fn done_line_counts_ok_and_errors() {
        assert_eq!(bench_done_line(6, 0), r#"NOIR_DONE {"errors":0,"ok":6}"#);
    }

    #[test]
    fn every_builder_stays_under_the_line_limit() {
        let device = device_line(&"m".repeat(60), &"m".repeat(60), "s", "s", "34", 1, 1, &vec![Some(2_800_000); 8], 8);
        assert!(device.len() < MAX_LINE_BYTES, "{} bytes", device.len());
        assert!(iter_line(&times(true, false)).len() < MAX_LINE_BYTES);
    }

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("noir-bench-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stage_file_copies_and_creates_parents() {
        let dir = scratch_dir("stage");
        let src = dir.join("src.bin");
        std::fs::write(&src, vec![7u8; 4096]).unwrap();
        let dest = dir.join("a/b/dest.bin");
        let n = bench_stage_file(src.to_string_lossy().into(), dest.to_string_lossy().into()).unwrap();
        assert_eq!(n, 4096);
        assert_eq!(std::fs::read(&dest).unwrap(), vec![7u8; 4096]);
    }

    #[test]
    fn stage_file_overwrites_a_longer_existing_file() {
        let dir = scratch_dir("overwrite");
        let src = dir.join("src.bin");
        let dest = dir.join("dest.bin");
        std::fs::write(&dest, vec![1u8; 9000]).unwrap();
        std::fs::write(&src, b"new").unwrap();
        bench_stage_file(src.to_string_lossy().into(), dest.to_string_lossy().into()).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn stage_file_reports_a_missing_source() {
        let dir = scratch_dir("missing");
        let error = bench_stage_file("/nonexistent/src.bin".into(), dir.join("never.bin").to_string_lossy().into())
            .unwrap_err();
        assert!(format!("{error}").contains("cannot open /nonexistent/src.bin"), "got: {error}");
    }

    #[test]
    fn proof_bytes_counts_decoded_bytes() {
        assert_eq!(proof_bytes("0xabcd"), 2);
        assert_eq!(proof_bytes("0x"), 0);
        assert_eq!(proof_bytes(""), 0);
    }

    #[test]
    fn the_witness_fixture_is_the_credential_circuits_239_values() {
        assert_eq!(witness().len(), 239);
    }
}
