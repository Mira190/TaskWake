# HANDOFF — continue without rereading the repo

For the next agent (any size). Everything you need to work safely is here + the four files
this points at. Written 2026-08-06 on branch `claude/blindspot-analysis-research-f60hjv`
(PR #1 → main).

## What this project is, in three sentences

TaskWake is a zero-dependency Claude Code plugin: when a turn dies on a usage limit or API
overload, a `StopFailure` hook records the session under `~/.taskwake/pending/` and spawns
one detached waiter process, which waits for the reset and then re-continues the session —
in a new visible terminal if a desktop is available (`resumeMode: "hybrid"`, default), else
headlessly via `claude --resume <id> -p`. A separate CLI wrapper (`taskwake run codex
exec …`) does usage-limit retry for OpenAI Codex batch runs. There is also a localhost
dashboard, a bounded opt-in autonomous loop ("Ralph"), and a Windows boot-recovery scheduler.

## Map (what lives where)

| Path | Role | Touch when… |
|---|---|---|
| `src/core.js` | ALL pure logic: banner regexes, `resetEpoch` time parsing, `classifyProbe` probe verdicts, `estimateTokens`, codex argv/stream helpers | adding any testable logic (keep it I/O-free) |
| `src/store.js` | config load (global `~/.taskwake.json` + per-project `.taskwake.json` overlay), atomic JSON state I/O, `listJson`/`aliveProcess`, spawning (`runCommand`, `openTerminal`, `canShowTerminal`), notifications | I/O or platform quirks |
| `src/hook.js` | hook entrypoint (`saveEvent`, `trackSession`, `reconcile`, `ralph`) | hook payload handling |
| `src/waiter.js` | per-session wait/probe state machine (`wait`, `initialDeadline`, gate claim/release, `recentResumeCount`) | resume policy |
| `src/dashboard.js` + `dashboard-page.js` | localhost HTTP + embedded SPA (template string!) | UI/API |
| `src/codex.js`, `bin/taskwake.js` | Codex wrapper; CLI | |
| `test/*.test.js` (50 tests) | `npm test` — must stay green | always |
| `bench/` | measurement harness — `npm run bench`; method in `docs/evaluation-methodology.md` | perf/quality claims |

Docs: `docs/architecture.md` (design + invariants) · `docs/critical-review.md` (findings,
ranked) · `DECISIONS.md` (why things are the way they are — **read before "simplifying"
anything**) · `KNOWN_FAILURES.md` (what's broken/unverified on purpose) ·
`docs/technical-debt.md` · `NEXT_STEPS.md` (ranked work queue) ·
`docs/blindspot-analysis-2026-07.md` (market/provider research, Phase 0–3 plan).

## Invariants you must not break

1. `core.js` stays pure (no fs/net/child_process imports).
2. Zero npm dependencies; Node ≥ 20; ESM.
3. Every state write is atomic (`writeAtomic`); deleting `~/.taskwake/` is a full reset;
   deleting a pending file cancels its waiter.
4. Bounded everything: `maxAttempts`, `ralphMaxTurns`, `weeklyResumeCeiling` (counts
   `resumed`, `resumed-idle`, **and `opened`** — the visible terminal auto-submits a prompt,
   so it spends quota), overload backoff array, context gates.
5. `classifyError` (hook.js) and `classifyProbe` (core.js) are deliberately dual-shape
   defensive — the real StopFailure/CLI contracts are UNVERIFIED (no live captures exist).
   Do not simplify them until Phase-0 capture lands (NEXT_STEPS #1).
6. Never treat exit-0 + non-error JSON result as anything but success; never banner-scan a
   successful reply (that exact bug was shipped once — KNOWN_FAILURES #1).
7. Dashboard auth layers all stay: Host allowlist + per-launch token on every route;
   Origin + `X-TaskWake-Action` additionally on POST `/api/open`. Tests reach it via
   `server.taskwakeUrl`.
8. New behaviour lands with a test that fails before the change. Perf claims land with
   baseline+improved JSONs in `bench/results/` (protocol: `docs/evaluation-methodology.md`).

## How to verify your work

```
npm test          # 50/50 must pass (bare `node --test`; do NOT pass a directory — broken on Node 22.22.x)
npm run bench     # parser + snapshot benches; label runs: node bench/parser-bench.mjs <label>
node bin/taskwake.js status   # CLI smoke (use TASKWAKE_HOME=/tmp/... to sandbox state)
```
Tests sandbox all state via `REWAKE_HOME`/`REWAKE_CONFIG` env pinned before dynamic import —
copy that pattern (see top of `test/waiter.test.js`) for anything touching `store.js` state.

## Current state / what just happened

- Upstream `main` (v1.2.2: hybrid visible-terminal resume, dashboard "Open session",
  Ralph-state cleanup) was merged; conflict resolutions are documented in DECISIONS #8–11.
- This branch previously fixed the StopFailure field-precedence + `error_details` contract
  bugs, added structured probe classification, bricked/idle detection, token gate, weekly
  ceiling, per-project config, dashboard token auth (see PR #1 description).
- The improvement pass then: fixed `npm test` (Node 22.22.x directory-arg breakage), added
  `classifyProbe` (closing a false positive the benchmark caught in my own earlier fix),
  fixed Codex chunk-split thread loss, honoured machine-readable reset hints, added snapshot
  caching (101→6.8 ms warm poll at 30 sessions, staleness-tested), released the probe gate
  on skip-context, and deduped helpers. All measured/tested: `BENCHMARK_RESULTS.md`.

## Your work queue

Take `NEXT_STEPS.md` top-down. #4 (status-vocabulary table), #5 (done/ pruning), #6 (lint
script) are small, safe, and fully specified by their debt entries — good first tasks. #1–2
need a live account / real OSes; if you have neither, skip to #3–#7. Anything in
NEXT_STEPS #8 is deliberately deferred — don't pick it up without new evidence.

## Gotchas that will waste your time if you don't know them

- `store.js` resolves env/home at import time → pin `REWAKE_HOME` **before** importing it.
- `dashboard-page.js` is one giant `String.raw` template — `node --check` does not parse
  the embedded browser JS; a bad merge seam there won't fail until a browser loads it.
- Windows spawn paths quote by stripping embedded quotes (cmd.exe has no safe escape) —
  don't "fix" the quoting without reading the CVE-2024-27980 comment in `store.js`.
- Test config factory sets `resumeMode: 'headless'` so waiter tests never try to open real
  terminals; keep that for any new `wait()` test.
- The bench's cold-scenario **mean** is flattered by caching; only its **max** is the true
  cold number (KNOWN_FAILURES #5).
- `git push -u origin claude/blindspot-analysis-research-f60hjv` updates PR #1; never push
  elsewhere without explicit permission.
