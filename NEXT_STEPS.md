# Next Steps

Ranked by information value ÷ cost. Items 1–2 are blocked on resources this environment
does not have (live Claude account, real desktop OSes); everything after them is executable
by any contributor. Full context for 1–3: `docs/blindspot-analysis-2026-07.md` §8.

1. **Phase-0 empirical capture (highest information value; blocks everything strategic).**
   On a real machine with a real account: hook a payload-dumper on all events, force a
   429/limit, and capture (a) whether a subscription seat limit fires StopFailure at all and
   with which `error_type`/`error_details` shape; (b) whether `claude --resume <id> -p`
   preserves the session id (upstream #10806 says sometimes not); (c) exit codes + JSON
   output of a limited `-p` run; (d) whether the hybrid terminal path's auto-submitted
   `retryText` behaves as coded on Windows/macOS/Linux. Feed real payloads into
   `bench/fixtures/eval-corpus.json` and `test/fixtures/`, then simplify the dual-shape
   defensive parsing per DECISIONS #12. **If seat limits fire no hook, pivot detection**
   (transcript-tail watcher or SessionEnd+usage check) before building anything else.
2. **Windows verification pass** — run the suite + scheduler install + toast + terminal
   open on real Windows (KNOWN_FAILURES #8, debt #4).
3. **Phase-2 differentiators, remaining** (in priority order, per the competitive
   analysis): quota-aware resume governor (OAuth usage endpoint behind a feature flag +
   "refuse to burn the last N% of the weekly window" policy); checkpoint/handoff file
   written at StopFailure time + `resumeMode: "fresh-context"`; tools-used reporting
   (turns, cost, AND files-changed already land in done-records, notifications, and
   `taskwake status` as of round 2); Codex `resets_at` structured parsing — deferred until
   a real `--json` event sample is captured (coding against the unverified shape from
   issue #21073 repeats the contract-drift anti-pattern this repo keeps paying for).
   *Done in round 2 (2026-08-14):* workspace fingerprint hold
   (`workspacePolicy: "hold"` default), turns/cost/files-changed resume reporting, status
   vocabulary table, `done/` pruning, `npm run lint` (incl. embedded dashboard JS parse).
4. **Split `test/waiter.test.js`** by subject next time it grows (debt #9) — it grew again
   in round 2 (~640 lines); next behavioural addition should split it first.
5. **Deferred deliberately — do not pick up without new evidence:** multi-machine gate
   coordination (needs demand signal), `resetEpoch` performance (KNOWN_FAILURES #3),
   `wait()` refactor (debt #2 — only alongside the next behavioural change there),
   legacy-`rewake` removal (major version only), multi-account anything (ToS red line).

## Standing guardrails (unchanged)

Bounded-everything defaults stay on; `opened` counts as spend; never build multi-account
rotation; keep `core.js` pure; new behaviour lands with a failing-before test; benchmark
labels follow `docs/evaluation-methodology.md`.
