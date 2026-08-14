# Critical Review — first principles

Date: 2026-08-06. Scope: whole repository at merge of upstream v1.2.2 + this branch.
Companion docs: `docs/architecture.md` (what exists), `docs/blindspot-analysis-2026-07.md`
(market/provider research), `BENCHMARK_RESULTS.md` (measurements), `KNOWN_FAILURES.md`
(negative results), `NEXT_STEPS.md` (ranked remaining work).

## 1. Reconstructed intent

- **Goal:** when a Claude Code (or Codex) work session is killed by a usage limit or
  overload, get the work moving again at the earliest legitimate moment, with zero manual
  babysitting, without bypassing quota, and without burning money the user didn't agree to
  spend.
- **Users:** individual Pro/Max subscribers running long agentic sessions — heavy users who
  hit 5-hour windows, often overnight, on their own desktop/laptop. Not teams, not CI.
- **Constraints:** consumer OS (Windows first-class), no daemons users must manage, no
  dependencies, must not violate Anthropic's "ordinary, individual usage" clause, and must
  stay honest about what it cannot do (revive a dead terminal, run while powered off).
- **Success criteria (implied):** (a) an interrupted session is continued at reset with
  useful work actually happening; (b) nothing resumes that the user would rather review;
  (c) the weekly window is never silently drained; (d) a user can always see what happened
  and why (`~/.taskwake/taskwake.log`, dashboard, `taskwake status`).

## 2. Is the architecture still the simplest reliable shape? — Yes, with caveats

The hook → pending-file → detached-waiter design is genuinely simpler and more robust than
every scraping competitor (tmux monitors, VS Code extensions, daemons), and upstream's new
hybrid visible-terminal path removes the biggest quality objection to headless-only resume.
Judged alternatives:

- *A persistent daemon* would simplify multi-session gating but adds an install/upgrade
  lifecycle and a failure mode users must manage; event-driven reconcile from SessionStart
  covers the same need at zero standing cost. **Keep current shape.**
- *Polling the OAuth usage endpoint instead of probe-by-doing* would be cheaper per check but
  builds on an undocumented endpoint; correct as an *addition* (see NEXT_STEPS), wrong as a
  replacement.
- *Merging waiter+hook+dashboard into one process* saves nothing; the pieces already share
  `core.js`/`store.js` and die independently, which is a feature.

The one structural weakness that remains: **the trigger contract is unverified** — nobody has
captured a real StopFailure payload for a subscription seat limit (vs an API 429). The whole
product hinges on that event firing; the code is now shape-defensive, but Phase 0 of
`docs/blindspot-analysis-2026-07.md` (empirical capture) is still the highest-information
unfinished task and cannot be closed from inside this sandbox.

## 3. Findings, ranked (severity × confidence ÷ cost)

| # | Finding | Severity | Confidence | Status |
|---|---------|----------|------------|--------|
| 1 | `npm test` fails on Node v22.22.2: `node --test <dir>` treats the directory as a literal test file (MODULE_NOT_FOUND). Reproduced in a minimal fresh project; not repo-specific. | High (CI-blocking) | Verified | **Fixed** — script is now bare `node --test` (default glob). |
| 2 | Classification false positive **survived my own earlier fix**: a successful JSON result whose reply text says "try again in 5 seconds" was still banner-scanned and misread as still-limited. Caught by the new benchmark, not by tests (the earlier test's sample text conveniently avoided the trigger phrase). | High | Verified (bench) | **Fixed** — `classifyProbe`: non-error JSON result + exit 0 = success, reply text never scanned. Bench: structured 5/5 vs raw 4/5; bare `failureKind` false-positives on 5/8 benign texts. |
| 3 | Codex thread-id loss on chunk split: `readCodexJson(String(part))` parsed each stream chunk alone; a `thread.started` JSONL line split across two data events lost the id, silently degrading resume to `--last` (can grab the wrong thread). | Medium-high | Verified (unit test reproduces) | **Fixed** — `codexStreamScanner` re-scans the accumulated tail. |
| 4 | Machine-readable reset hints treated as untrusted: `initialDeadline` re-parsed only the banner text, so a `retry_after_seconds`-derived `resetHint` (exact) still counted probes as untrusted attempts. | Medium | Verified (unit test) | **Fixed** — honours `state.resetParsed`. |
| 5 | Dashboard re-read and re-parsed every transcript tail (160 KB × N sessions) every 2-second poll with zero caching; warm poll cost equalled cold cost. | Medium (perf; matters at N≳10) | Measured | **Fixed** — mtime/size-gated activity cache + shared 60s project listing. 101 ms → 6.8 ms warm poll at 30×200 KB. Staleness guarded by a regression test. |
| 6 | Oversized session claims the account-wide probe gate, then skips, leaving the gate reserved for up to `usagePollMs` (1 h) — starving other sessions' probes. Introduced by the upstream restructure. | Medium | Verified (unit test) | **Fixed** — gate returned within ~1 min on skip-context. |
| 7 | Three copies of `listJson`/`aliveProcess` across dashboard/hook/bin, one missing the pid guard (pid 0 would signal the whole process group). | Low | Verified | **Fixed** — single guarded copy in `store.js`; net −18 lines. |
| 8 | Upstream's visible-terminal resume auto-submits `retryText` as an initial prompt — it spends quota unattended just like headless. The weekly ceiling and the "resume counts" accounting must (and now do) treat `opened` as spend. README claim "opens the same session … when a desktop is available" framed it as passive; it is not. | Medium (cost honesty) | High (code reading; not live-verified) | **Mitigated** — ceiling gates the visible path; `opened` counts toward the ceiling; README bullet updated. Live verification still pending (Phase 0). |
| 9 | Trigger contract unverified (StopFailure on seat limits; `--resume -p` session identity under #10806). | Existential if wrong | Unknown — cannot verify without a live account | **Open** — shape-defensive code + capture plan in NEXT_STEPS. |
| 10 | English-only banner parsing; wording drift across CLI releases silently degrades to the 5-h fallback. | Medium | High | **Open** — corpus now versioned in `bench/fixtures/`; parse-recall metric exists to catch drift when new banners are added. |
| 11 | `resetEpoch` throughput is ~4 k ops/s (Intl.DateTimeFormat cost) vs `failureKind`'s ~4 M ops/s. | None | Measured | **Not worth fixing** — it runs a handful of times per limit event; documented as a deliberate non-optimization (KNOWN_FAILURES.md). |
| 12 | Token-gate default (200k tokens ≈ 800 KB at 4 B/token) binds before the documented 2 MB byte gate — the effective oversize threshold is ~800 KB. | Low (doc honesty) | High | **Documented** — DECISIONS.md #5; both knobs kept. |

## 4. The seven questions, answered for each implemented optimization

**Snapshot caching (finding 5)**
- *Problem:* every dashboard poll paid full re-read/re-parse of all transcripts.
- *Evidence:* baseline bench, warm-idle ≈ cold (101 vs 111 ms at 30×200 KB).
- *Right layer:* dashboard read path — the data (mtime/size) needed for invalidation is
  already stat-ed there for `updatedAt`; no other layer sees both signals.
- *Simplest viable:* Map keyed by path → `(mtimeMs, size, events)`, blunt clear at 1,000
  entries. No TTL, no LRU.
- *Regression risk:* stale activity if a transcript changes without moving mtime **and**
  size (only sub-granularity same-size rewrites — not how JSONL appends behave). Guarded by
  an explicit invalidation test.
- *Measured:* 14.9× warm-idle, 11.3× warm-churn; true cold unchanged (~103 ms), as expected.
- *Would have proven it worthless:* warm-idle ≥ ~80% of cold after the change, or any
  invalidation test failure.

**`classifyProbe` short-circuit (finding 2)**
- *Problem/evidence:* bench miss `success-discussing-limits` (above); 5/8 benign texts
  trigger bare `failureKind`.
- *Right layer:* `core.js` — pure, shared by waiter *and* bench so the scored strategy is
  the shipped code, not a re-implementation that can drift.
- *Simplest viable:* trust a well-formed non-error JSON result with exit 0 outright.
- *Regression risk:* a CLI that emits `is_error: false` + exit 0 while actually still
  limited — that would be an upstream contract violation; raw-text scanning still covers
  non-JSON output.
- *Measured:* structured strategy 4/5 → 5/5; raw stays 4/5.
- *Falsifier:* any structured-strategy miss on the corpus, or a real-world still-limited
  probe classified as resumed (would surface as a `resumed` done-record whose session is
  immediately re-limited — visible in `taskwake.log`).

**Codex scanner / trusted hint / gate release (findings 3, 4, 6)** — each: problem shown by
a failing-before, passing-after unit test; layer chosen where the state lives; simplest
change that closes it (tail re-scan; one boolean OR; one `setUsageGate` call). Falsifiers:
the new tests. Cost: ~30 lines total.

**Not implemented on purpose:** see `KNOWN_FAILURES.md` (negative results) and
`NEXT_STEPS.md` (positive-value work that needs resources this sandbox lacks — live account,
real desktop, Windows host).

## 5. Claims audited

- "Works natively on Windows, macOS, and Linux" — *untested here* (Linux CI only);
  Windows-specific paths (cmd quoting, toast, scheduler, `canShowTerminal` probe) have unit
  coverage for logic but no OS-level verification. Flagged in KNOWN_FAILURES.md.
- "It does not bypass quota" — supported: waits for published reset, probe-verifies, and now
  budget-ceilinged. Consistent with the legal-and-compliance reading in the blindspot doc.
- "No tmux, no terminal scraping, no keystroke injection" — still true post-hybrid (it opens
  a *new* terminal; it does not inject into existing ones).
- README's former "Since June 15, 2026 … Agent SDK credit" — was false (change was paused);
  corrected this branch, evidence in blindspot doc §5.1.
