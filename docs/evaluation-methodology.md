# Evaluation Methodology

How TaskWake changes are measured, and how to reproduce every number in
`BENCHMARK_RESULTS.md`.

## Harness layout

```
bench/
  parser-bench.mjs        classification + reset-parse quality, strategy A/B, throughput
  snapshot-bench.mjs      dashboard buildSnapshot() latency under the real polling pattern
  fixtures/eval-corpus.json   labelled banners / benign texts / structured probe samples
  results/                one JSON per run: <bench>-<label>[-s<sessions>].json
```

Run everything: `npm run bench`. Label a run: `node bench/parser-bench.mjs <label>`
(label defaults to the short git rev — use `baseline` / `improved` around a change).

## Metrics

**parser-bench**
- `kindAccuracy`, `weeklyAccuracy` — exact-match classification over labelled banners.
- `parseRecall` — share of parseable banners where `resetEpoch` returns a real time rather
  than the sentinel fallback (parse *time correctness* is covered by unit tests; the bench
  measures only did-it-parse so new corpus entries don't need hand-computed epochs).
- `benignFalsePositives` — banner classifications fired on texts a successful resumed turn
  could legitimately produce. This is the metric that motivated `classifyProbe`.
- `strategies.raw` vs `strategies.structured` — end-to-end verdict accuracy on full
  `{code, stdout, stderr}` samples. **`structured` calls the production `classifyProbe`**,
  so the scored strategy is the shipped code by construction.
- `throughput` — sanity only; parsing runs a handful of times per limit event, so ops/sec is
  explicitly *not* an optimization target (see KNOWN_FAILURES.md).

**snapshot-bench** — fixture of N registered sessions with ~200 KB JSONL transcripts;
`buildSnapshot()` timed over 25 reps per scenario:
- `cold-first-snapshot` — caches empty. **Read `maxMs`, not `meanMs`**: after the caching
  change only rep 1 is truly cold, so the mean flatters the result; max isolates the honest
  cold cost.
- `warm-idle` — no transcript changed between polls (the dominant real pattern at a 2 s
  poll interval).
- `warm-churn` — one transcript appended to between polls (worst realistic case).
Run at both N=30 (heavy user) and N=3 (typical) — the small-N run exists to check whether
the optimization *matters*, not just whether it works.

## Protocol

1. Capture `baseline` on the pre-change commit (or with the change reverted).
2. Implement; add a unit test that fails before and passes after wherever the finding is
   behavioural.
3. Capture `improved` with identical fixture parameters; commit both JSONs.
4. Update `BENCHMARK_RESULTS.md` with the comparison **and** any result that went the wrong
   way or nowhere — negative results go to `KNOWN_FAILURES.md`, not the memory hole.

## Falsification rules (pre-registered)

- Snapshot caching is worthless if warm-idle ≥ 80% of cold afterwards, or if the
  cache-invalidation regression test (`serves cached activity on idle polls but reflects
  new transcript rows immediately`, test/waiter.test.js) ever fails.
- `classifyProbe` is wrong if any corpus sample regresses, or if production logs show a
  `resumed` verdict for a session that was in fact still limited (signature: `resumed`
  done-record followed immediately by a new StopFailure for the same session).
- Corpus metrics are only meaningful if new real-world banners get **added** to
  `eval-corpus.json` when observed; a frozen corpus measures memory, not reality.

## Known limits of this methodology

- No live-API evaluation: resume *quality* (did the continuation do useful work), token
  cost per resume, and the StopFailure trigger contract are unmeasurable without a real
  account and quota to burn. The metrics here are the measurable proxy layer beneath those.
- Timing numbers are single-machine (this container, Node v22.22.2, tmpfs-backed disk);
  treat ratios as transferable, absolute milliseconds as not.
- `structured` samples in the corpus are hand-authored against the documented CLI output
  format, not captured from a live CLI (that capture is NEXT_STEPS #1).
