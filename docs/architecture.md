# TaskWake Architecture

Current as of 2026-08-06 (post-merge of upstream v1.2.2 hybrid resume + this branch's
correctness/safety work). ~1,100 lines of dependency-free ESM across `src/`, `bin/`, `hooks/`.

## What it is

A Claude Code plugin plus a tiny local supervisor. When a Claude Code turn dies on a usage
limit or API overload, TaskWake records the interrupted session and re-continues it when the
limit resets — in a **visible terminal** when a desktop is available (`resumeMode: "hybrid"`,
the default) or **headlessly** via `claude --resume <id> -p` otherwise. A separate batch
wrapper does the same for OpenAI Codex (`taskwake run codex exec …`). No daemon, no tmux, no
keystroke scraping.

## Components

```
Claude Code ──(hook events, stdin JSON)──▶ src/hook.js
                                             │  StopFailure: classifyError → pending/<id>.json → spawn waiter
                                             │  SessionStart: track session + reconcile() orphans
                                             │  SessionEnd:  mark ended, clear ralph state
                                             │  Stop:        ralph() bounded autonomous loop (opt-in)
                                             ▼
                                  src/waiter.js  (one detached process per interrupted session)
                                             │  gates: weekly-limit policy → weekly resume ceiling →
                                             │         oversized (bytes OR est. tokens) deferral
                                             │  account-wide probe gate: ~/.taskwake/usage-gate.json + .lock
                                             │  at deadline: visible terminal (hybrid) else headless probe
                                             │  classifyProbe() verdict → resumed / resumed-idle / bricked /
                                             │         still-limited (re-wait) / overload (backoff) / gave-up
                                             ▼
                        ~/.taskwake/{pending,done,sessions,ralph}/*.json   (all state = flat JSON files)
                                             ▲
        bin/taskwake.js (CLI) ───────────────┤
        src/dashboard.js (127.0.0.1 HTTP) ───┘  read-only snapshot + POST /api/open takeover
        src/codex.js (batch wrapper) — independent leg, shares core.js parsing only
```

- **`src/core.js`** — pure functions only (no I/O): banner classification (`failureKind`,
  `isWeekly`), reset-time parsing (`resetEpoch` — relative / dated / IANA-zone clock forms),
  probe verdicts (`classifyProbe`), payload helpers (`estimateTokens`, `looksIdle`,
  `looksBricked`, `parseCliJsonResult`), Codex argv surgery (`codexExecIndex`,
  `jsonCodexArgs`, `codexResumeArgs`, `readCodexJson`, `codexStreamScanner`), path/id
  utilities. Everything testable without a filesystem.
- **`src/store.js`** — config + state I/O: `loadConfig(cwd?)` (global `~/.taskwake.json`
  overlaid by project-local `.taskwake.json`), atomic JSON writes, `listJson`,
  `aliveProcess`, `runCommand`/`shellSpawn` (Windows .cmd quirks), `canShowTerminal` /
  `openTerminal` (hybrid resume), desktop notifications, legacy `~/.rewake` compatibility.
- **`src/hook.js`** — hook entry point (`node hook.js [mode]` reading stdin JSON).
  `classifyError` prefers the documented `error_type` token, tolerates token-shaped `error`,
  never treats a message string as a type. `saveEvent` extracts
  `error_details.retry_after_seconds` as the primary reset hint (`resetParsed: true`).
  `reconcile()` re-arms orphaned waiters (PID liveness + freshness heuristics).
- **`src/waiter.js`** — the state machine described above. `initialDeadline` trusts either a
  re-parseable banner or a machine-derived `resetHint` (`resetParsed`). The usage gate
  ensures at most one account-wide probe per `usagePollMs` (lock file with 2-min stale
  takeover); the gate is returned early on skip-context. Weekly ceiling counts
  `resumed`/`resumed-idle`/`opened` done-records in a rolling 7 days.
- **`src/dashboard.js` / `src/dashboard-page.js`** — localhost control room. Auth layers:
  loopback Host-header allowlist → per-launch random token (all routes) → for POST
  `/api/open` additionally Origin + `X-TaskWake-Action` header + session-id validation +
  busy-state 409. Snapshot caching: per-transcript activity cache keyed by `(mtimeMs, size)`;
  shared 60s recursive listing of `~/.claude/projects` for transcript discovery.
- **`src/codex.js`** — streams `codex exec --json`, scans the accumulated tail
  (`codexStreamScanner`, chunk-split safe) for the thread id and usage banners; on a usage
  limit waits for the parsed reset and reruns `codex exec resume --json <thread>`.
- **`hooks/hooks.json`** — exec-form hook registrations (Stop, SessionStart, SessionEnd,
  StopFailure matcher `rate_limit|overloaded|server_error`), 10s timeouts.
- **`commands/*.md`** — `/taskwake:status`, `/taskwake:logs`, `/taskwake:cancel` slash commands.

## Key invariants

1. **All state is flat JSON under `~/.taskwake/`**; every write is atomic
   (temp file + rename). Deleting the directory is a full reset. A pending file's existence
   IS the waiter's claim; deleting it cancels the waiter within a minute (CHUNK sleep).
2. **At most one usage probe per account per `usagePollMs`** across all waiters (gate file);
   probe results update the gate for everyone.
3. **Bounded everything**: `maxAttempts` probes, `ralphMaxTurns` turns, `weeklyResumeCeiling`
   auto-resumes per 7 days, overload backoff array, 2 MB / 200k-token context gates.
4. **Hooks are side-effect-only** for StopFailure (output ignored by Claude Code); only the
   Stop hook returns JSON (`decision: "block"` for Ralph).
5. **`core.js` stays pure** — new logic that needs unit tests without I/O belongs there.
6. **Nothing writes to the user's repos**; TaskWake only spawns `claude`/`codex` and touches
   `~/.taskwake`.

## Consciously accepted limitations

- Reset-time parsing is English-banner-only (fallback: 5-hour wait, then probe-verify).
- Boot recovery is Windows-only (Task Scheduler); macOS/Linux recover on next SessionStart.
- The account gate is per-machine; two machines on one account will not coordinate.
- Byte→token estimation is a 4-bytes/token heuristic (deliberately conservative).
- PID-reuse can make `reconcile` briefly false-skip an orphan (self-heals next reconcile).
