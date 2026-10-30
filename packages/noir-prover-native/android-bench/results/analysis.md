# Device results

## Warnings

- a55xzh-36: sessions report different MemTotal: 20261028T025220Z=7607776 kB, 20261030T030621Z=7607772 kB
- caiman-34: sessions report different MemTotal: 20261028T034135Z=15926120 kB, 20261030T032547Z=15926036 kB
- dm3q-34: sessions report different MemTotal: 20261028T034141Z=11294228 kB, 20261030T032531Z=11294224 kB
- infinix-x6525-33: sessions report different build fingerprints: 20261028T031715Z=Infinix/X6525-OP/Infinix-X6525:13/TP1A.220624.014/250313V1928:user/release-keys, 20261030T024144Z=Infinix/X6525-OP/Infinix-X6525:13/TP1A.220624.014/250513V1942:user/release-keys

## Feature × tier matrix

Each cell shows prediction → measurement. A miss is a different runs-or-not, or time or RAM off by more than 2x. † thermally gated or throttled runs are left out of the time and RAM columns. ‡ the run needed its retry.

| Row | Tier | Runs | Verified | Cold s | Warm median s (min–max) | Peak MiB | Verdict |
|---|---|---|---|---|---|---|---|
| CN presentation | budget | yes → yes (3/3) | 3/3 | 14.2 → 15.7 | 7.78 → 9.11 (7.75–10.3) | 394 → 633 | ok |
| CN presentation | mid | yes → yes (3/3) | 3/3 | 5.54 → 4.78 | 3.04 → 2.82 (2.72–3.62) | 394 → 517 | ok |
| CN presentation | flagship | yes → yes (4/4) | 4/4 | 3.90 → 3.31 | 2.14 → 1.93 (1.41–2.84) | 394 → 460 | ok |

### Step detail

| Row | Tier | Runs | Verified | Cold s | Warm median s (min–max) | Peak MiB | Verdict |
|---|---|---|---|---|---|---|---|
| CN presentation, low-memory mode | budget | yes (3/3) | 3/3 | 16.1 | 9.45 (7.97–10.2) | 500 | no prediction |
| CN presentation, low-memory mode | mid | yes (3/3) | 3/3 | 4.87 | 2.91 (2.85–3.77) | 525 | no prediction |
| CN presentation, low-memory mode | flagship | yes (4/4) | 4/4 | 3.35 | 2.00 (1.46–2.83) | 487 | no prediction |

### Primitives

Single-primitive proofs outside the main matrix, with the same columns as the step detail.

| Row | Tier | Runs | Verified | Cold s | Warm median s (min–max) | Peak MiB | Verdict |
|---|---|---|---|---|---|---|---|
| UltraHonk SHA-256, 2 KB | budget | yes → yes (3/3) | 3/3 | 17.5 | 9.24 → 10.5 (10.2–15.5) | 438 → 739 | ok |
| UltraHonk SHA-256, 2 KB | mid | yes → yes (3/3) | 3/3 | 5.25 | 2.86 → 3.20 (3.04–4.14) | 438 → 572 | ok |
| UltraHonk SHA-256, 2 KB | flagship | yes → yes (4/4) | 4/4 | 3.52 | 1.95 → 2.19 (1.56–3.20) | 438 → 509 | ok |
| UltraHonk P-256 verify | budget | yes → yes (3/3) | 3/3 | 4.73 | 2.94 → 3.05 (3.00–3.37) | 131 → 253 | ok |
| UltraHonk P-256 verify | mid | yes → yes (3/3) | 3/3 | 1.57 | 0.91 → 1.10 (0.96–1.28) | 131 → 319 | MISS: RAM |
| UltraHonk P-256 verify | flagship | yes → yes (4/4) | 4/4 | 1.05 | 0.62 → 0.78 (0.49–1.09) | 131 → 308 | MISS: RAM |

## Devices

| Device | Tier | Model | SoC | RAM GiB | Android | MemAvailable before MiB | Thermal (start → max, gated, throttled) | Session | Flags |
|---|---|---|---|---|---|---|---|---|---|
| a06-35 | budget | SM-A065M | Mediatek MT6769V/CZ | 3.6 | 15 | 1,306–1,539 | 0 → 0, 0 gated, 0 throttled | 20261028T031724Z (noir-credential), 20261030T021605Z (noir-primitives) | - |
| infinix-x6525-33 | budget | Infinix X6525 | Spreadtrum T606 | 3.7 | 13 | 2,388–2,511 | 0 → 0, 0 gated, 0 throttled | 20261028T031715Z (noir-credential), 20261030T024144Z (noir-primitives) | - |
| lamul-35 | budget | moto g05 | Mediatek MT6769V/CB | 3.6 | 15 | 1,801–1,862 | 0 → 0, 0 gated, 0 throttled | 20261028T031552Z (noir-credential), 20261030T025043Z (noir-primitives) | - |
| a35x-34 | mid | SM-A356U1 | Samsung s5e8835 | 5.3 | 14 | 2,783–2,807 | 0 → 0, 0 gated, 0 throttled | 20261028T033431Z (noir-credential), 20261030T025919Z (noir-primitives) | - |
| a55xzh-36 | mid | SM-A5560 | Samsung s5e8845 | 7.3 | 16 | 3,999–4,192 | 0 → 0, 0 gated, 0 throttled | 20261028T025220Z (noir-credential), 20261030T030621Z (noir-primitives) | - |
| akita-35 | mid | Pixel 8a | Google Tensor G3 | 7.4 | 15 | 3,273–3,685 | 0 → 0, 0 gated, 0 throttled | 20261028T033027Z (noir-credential), 20261030T031305Z (noir-primitives) | - |
| caiman-34 | flagship | Pixel 9 Pro | Google Tensor G4 | 15.2 | 14 | 10,419–10,778 | 0 → 0, 0 gated, 0 throttled | 20261028T034135Z (noir-credential), 20261030T032547Z (noir-primitives) | - |
| dm3q-34 | flagship | SM-S918B | QTI SM8550 | 10.8 | 14 | 6,875–7,005 | 0 → 0, 0 gated, 0 throttled | 20261028T034141Z (noir-credential), 20261030T032531Z (noir-primitives) | - |
| grizzly-37 | flagship | Pixel 11 Pro | Google Tensor G6 | 11.4 | 17 | 6,634–6,807 | 0 → 0, 0 gated, 0 throttled | 20261028T034629Z (noir-credential), 20261030T031832Z (noir-primitives) | - |
| m2q-36 | flagship | SM-S947U1 | QTI SM8850 | 10.9 | 16 | 6,120–6,656 | 0 → 0, 0 gated, 0 throttled | 20261028T035133Z (noir-credential), 20261030T031204Z (noir-primitives) | - |

## Proof and artifact sizes

| Workload | Step | Proof | Artifacts on the phone |
|---|---|---|---|
| noir-credential | prove | 14.7 KB | circuit 2.1 MB, srs 8.4 MB, vk 3.7 KB |
| noir-primitives | ecdsa | 14.7 KB | circuit 6.1 KB, srs 4.2 MB, vk 3.7 KB |
| noir-primitives | sha256 | 14.7 KB | circuit 552.9 KB, srs 16.8 MB, vk 3.7 KB |

## Phone-to-host time ratios

| Row | Host | Tier | Phone warm s (prove_ms) | Host warm s (prove_ms) | Warm ÷ warm | Phone cold s (total_ms) | Host cold s (total_ms, else wall†) | Cold ÷ cold |
|---|---|---|---|---|---|---|---|---|
| CN presentation | Apple M5 Max | budget | 9.11 | 0.57 | 16.1x | 15.7 | 1.03 | 15.3x |
| CN presentation | Apple M5 Max | mid | 2.82 | 0.57 | 5.0x | 4.78 | 1.03 | 4.6x |
| CN presentation | Apple M5 Max | flagship | 1.93 | 0.57 | 3.4x | 3.31 | 1.03 | 3.2x |
| UltraHonk SHA-256, 2 KB | Apple M5 Max | budget | 10.5 | 0.57 | 18.2x | 17.5 | 1.00 | 17.5x |
| UltraHonk SHA-256, 2 KB | Apple M5 Max | mid | 3.20 | 0.57 | 5.6x | 5.25 | 1.00 | 5.2x |
| UltraHonk SHA-256, 2 KB | Apple M5 Max | flagship | 2.19 | 0.57 | 3.8x | 3.52 | 1.00 | 3.5x |
| UltraHonk P-256 verify | Apple M5 Max | budget | 3.05 | 0.18 | 16.7x | 4.73 | 0.29 | 16.4x |
| UltraHonk P-256 verify | Apple M5 Max | mid | 1.10 | 0.18 | 6.0x | 1.57 | 0.29 | 5.5x |
| UltraHonk P-256 verify | Apple M5 Max | flagship | 0.78 | 0.18 | 4.2x | 1.05 | 0.29 | 3.7x |

† wall time of a fresh host process, used where the host has no `total_ms` for its cold run; it includes process start. ( ) numbers come from unverified runs and ⚑ from runs with errors.
