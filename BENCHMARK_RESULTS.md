# Benchmark Results

Environment: Linux container, Node v22.22.2, tmpfs-backed disk. Raw JSON in
`bench/results/`. Method + falsification rules: `docs/evaluation-methodology.md`.
Baseline = merge commit of upstream v1.2.2 + Phase-1 branch (78a077d), before this
improvement pass. Improved = this pass.

## Classification & parsing quality (parser-bench)

| Metric | Baseline | Improved | Meaning |
|---|---|---|---|
| Banner kind accuracy | 22/22 | 22/22 | labelled limit/overload banners |
| Weekly detection | 22/22 | 22/22 | |
| Reset parse recall | 13/13 | 13/13 | parseable banners actually parsed |
| Benign false positives (bare `failureKind`) | 5/8 | 5/8 | why raw text scanning is dangerous — unchanged by design; the fix is to stop *applying* it to successful replies |
| **End-to-end verdicts — raw strategy** | 4/5 | 4/5 | full-output scanning (pre-1.x behaviour) |
| **End-to-end verdicts — structured strategy** | **4/5** | **5/5** | production `classifyProbe` |

The baseline structured miss (`success-discussing-limits`: a successful JSON result whose
reply says "try again in 5 seconds" → misread as still-limited) is the false positive my own
Phase-1 change claimed to have fixed and had not — the harness caught it. Fix: a well-formed
non-error JSON result with exit 0 is trusted outright; reply text is never banner-scanned.

Throughput (sanity, not a target): `failureKind` ~3.3–4.1 M ops/s; `resetEpoch` ~4 k ops/s
(Intl.DateTimeFormat dominated). Both irrelevant at real call rates — see KNOWN_FAILURES.md.

## Dashboard snapshot latency (snapshot-bench, 25 reps, mean ms)

**30 sessions × 200 KB transcripts** (heavy user):

| Scenario | Baseline | Improved | Ratio |
|---|---|---|---|
| Cold (honest = max of run) | 152.0 max / 111.0 mean | **102.8 max** / 11.0 mean | ~1× (expected — cache can't help a first view; improved *mean* is flattered by 24 cached reps and should be ignored) |
| Warm idle (common case) | 101.3 | **6.8** | **14.9×** |
| Warm churn (1 file changed/poll) | 102.3 | **9.0** | **11.3×** |

At a 2 s poll interval the baseline dashboard spent ~5% of wall-clock re-parsing unchanged
transcripts (~6 MB reads/poll at this fixture size); improved spends ~0.3%.

**3 sessions × 200 KB** (typical user):

| Scenario | Baseline | Improved |
|---|---|---|
| Warm idle | 11.6 | 1.0 |

Honest reading: at typical scale both are imperceptible; the optimization is justified by
the 30-session case and by not doing pointless I/O every 2 seconds, not by user-visible
speed at N=3. (Falsification check passed: warm-idle « 80% of cold.)

## Correctness fixes proven by failing-before tests (no timing dimension)

| Fix | Test |
|---|---|
| Codex thread id lost when `thread.started` splits across stream chunks | `codex stream scanning › finds the thread id even when the JSONL line is split across chunks` |
| Machine-readable `retry_after_seconds` hint treated as untrusted → burned attempts | `initial deadline trust` |
| Account probe gate held ~1 h by a session that skipped | `usage gate release on skip` |
| Snapshot cache staleness (risk introduced by this pass) | `serves cached activity on idle polls but reflects new transcript rows immediately` |
| `npm test` broken on Node v22.22.2 (`node --test <dir>` → MODULE_NOT_FOUND; reproduced in a clean project) | script now bare `node --test`; 50/50 pass via `npm test` |

## Test suite

Baseline: 43 tests. Improved: **50 tests, 50 pass** (`npm test`).
