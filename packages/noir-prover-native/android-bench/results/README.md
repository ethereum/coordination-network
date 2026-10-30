# Android bench results

Ten physical Android phones on Google's Developer Device Platform, from 4 GB budget phones to
flagships, ran this branch's harness ([`../README.md`](../README.md)) on 28 and 30 October 2026.
Every number below comes from the files in this directory.

- 28 October, [`bench_workload.json`](../bench_workload.json): the credential presentation, one
  proof of the circuit's eight checks, as run `noir-credential`, and again with Barretenberg's
  low-memory mode as `noir-credential-lowmem`.
- 30 October, [`bench_workload_primitives.json`](../bench_workload_primitives.json): CSP's SHA-256
  over 2 KB and ECDSA P-256 verify circuits, as runs `noir-sha256` and `noir-ecdsa`.

Each run is a fresh app process. [`BenchTest.kt`](../app/src/androidTest/java/org/coordination/nbench/BenchTest.kt)
runs iteration 0 cold (it loads the SRS and circuit and derives the verification key) and then five
warm iterations, 10 s apart. `bench_iteration` in [`rust/src/bench.rs`](../../rust/src/bench.rs)
times each iteration and reads its peak memory, VmHWM after a reset through `/proc/self/clear_refs`.
The last proof of every run was pulled and verified on a laptop.

## Per phone

Cold is iteration 0, including loading; warm is the median of the five warm iterations; peak
is the highest VmHWM across the run's iterations. `analysis.md` has the tier medians beside
the laptop predictions they were checked against, the phones, and proof sizes.

### Credential presentation, 28 October

| Phone | Tier | Presentation: cold s | warm s | peak MiB | Low-memory mode: cold s | warm s | peak MiB |
|---|---|---|---|---|---|---|---|
| Galaxy A06 | budget | 13.3 | 7.85 | 633 | 13.6 | 8.11 | 500 |
| Infinix SMART 8 | budget | 15.7 | 9.11 | 418 | 16.1 | 9.45 | 458 |
| moto g05 | budget | 16.9 | 9.61 | 396 | 16.6 | 10.2 | 393 |
| Galaxy A35 | mid | 6.11 | 3.58 | 492 | 6.20 | 3.73 | 481 |
| Galaxy A55 | mid | 4.70 | 2.77 | 517 | 4.86 | 2.86 | 525 |
| Pixel 8a | mid | 4.78 | 2.82 | 449 | 4.87 | 2.91 | 454 |
| Pixel 9 Pro | flagship | 4.67 | 2.78 | 414 | 4.69 | 2.79 | 413 |
| Galaxy S23 Ultra | flagship | 3.26 | 1.90 | 426 | 3.38 | 2.04 | 487 |
| Pixel 11 Pro | flagship | 3.35 | 1.95 | 410 | 3.32 | 1.97 | 397 |
| Galaxy S26+ | flagship | 2.42 | 1.42 | 460 | 2.48 | 1.47 | 447 |

### Single checks, 30 October

| Phone | Tier | SHA-256, 2 KB: cold s | warm s | peak MiB | P-256 verify: cold s | warm s | peak MiB |
|---|---|---|---|---|---|---|---|
| Galaxy A06 | budget | 18.1 | 10.7 | 739 | 4.73 | 3.33 | 250 |
| Infinix SMART 8 | budget | 17.1 | 10.3 | 458 | 4.60 | 3.03 | 235 |
| moto g05 | budget | 17.5 | 10.5 | 448 | 4.82 | 3.05 | 253 |
| Galaxy A35 | mid | 6.61 | 4.01 | 502 | 1.75 | 1.24 | 283 |
| Galaxy A55 | mid | 5.11 | 3.06 | 572 | 1.39 | 0.98 | 319 |
| Pixel 8a | mid | 5.25 | 3.20 | 490 | 1.57 | 1.10 | 274 |
| Pixel 9 Pro | flagship | 5.16 | 3.16 | 468 | 1.59 | 1.08 | 262 |
| Galaxy S23 Ultra | flagship | 3.48 | 2.15 | 509 | 1.06 | 0.77 | 308 |
| Pixel 11 Pro | flagship | 3.56 | 2.23 | 459 | 1.04 | 0.79 | 262 |
| Galaxy S26+ | flagship | 2.59 | 1.56 | 503 | 0.72 | 0.53 | 269 |

## Notes

- The 28 October runs used the harness as of d9f52a0 and the 30 October runs as of 34ad749. Both
  builds predate this branch's rebase onto `main`, which changed nothing under `rust/`,
  `android-bench/`, `scripts/` or `packages/circuits`. Each `session.json` records the sha256 of the
  APKs that ran. Between the two, the single-check steps were added and parsing the compiled-in
  239-value witness moved out of the timed region.
- The cold iteration includes deriving the verification key, which `vk_ms` in the `.jsonl` records
  also reports; an app that caches the key skips it.
- The Infinix SMART 8's firmware changed between the two dates (`analysis.md`, Warnings). Its
  readings may run low: four of its five warm SHA-256 iterations read 222 to 228 MiB, against 446
  to 448 MiB on the moto g05, as its OpenAC readings do in zkID's results.

## Files

`<phone>/<UTC start>/` is one session of the host runner on one phone:

- `session.json`: the phone's properties and memory, the APKs and pushed files with their sha256,
  and one entry per run attempt with its outcome, temperature, free memory and verification result.
- `<workload>.jsonl`: one record per line, `device`, `run`, `iter` (per iteration: `phase`,
  `load_ms`, `prove_ms`, `total_ms`, `peak_rss_kb`), `size` and `sample`.
- `raw/<run>-<attempt>.log`: the phone's logcat for that attempt, trimmed (below).
- `raw/<run>-<attempt>-out/`: the proofs pulled from the phone.

A run that didn't finish was retried once, and both attempts are kept. Where a phone has more than
one session for a workload, `analysis.md` uses the latest; its Devices table lists which.

The logs keep the logcat buffer headers, every marker line, every line from the app's processes,
and Android's process start, kill, death, crash and memory lines that name the app. Window,
package-manager and display services, which name the app thousands of times, are left out.
Normalizing these trimmed logs gives the same `.jsonl` records as the full logs. The full logs, the
host runner (`run_device.py`) and the predictions are kept with the article this benchmark was run
for, in a repository that is not yet public.
