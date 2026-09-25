# TaskWake v1.3.0 — Implementation Plan

Status: implemented in v1.3.0 on branch `claude/adoring-galileo-2gov7j` (all 12 work items; see CHANGELOG.md).
Scope: correctness fixes to the waiter state machine and hook plumbing, safer
resume behaviour, dashboard hardening, and test/CI hygiene. No new runtime
dependencies. Node 20 must keep working (CI matrix below enforces it).

Verified against the official Claude Code hooks reference on 2026-09-25:
`StopFailure` delivers `error`, `error_details`, `last_assistant_message`;
`SessionStart` delivers `source` and optional `model`; `SessionEnd` delivers
`reason`; exec-form hooks (`command` + `args`) spawn with no shell; a `Stop`
hook may return `{"decision":"block","reason":…}`, and Claude Code ends the
turn after **8 consecutive blocks** regardless of the hook.

---

## 0. Findings from the re-analysis

| # | Severity | Where | Problem |
|---|----------|-------|---------|
| F1 | high | `package.json` `scripts.test` | `node --test test/` fails on Node 22 (directory args are no longer modules). `node --test` alone auto-discovers `test/**/*.test.js` on 20 and 22. There is no CI, so this went unnoticed. |
| F2 | high | `src/waiter.js` `wait()` | For an **unparseable** usage banner every hourly probe increments `attempts`, so with `maxAttempts: 4` the waiter gives up ~4 h after the failure although the fallback window is 5 h. The deadline is also re-based to `now + fallbackMs` on every failed probe, so `now >= deadline` is never true and the hybrid visible-terminal path is unreachable for unparseable banners. |
| F3 | high | `src/waiter.js` `initialDeadline`/`wait()` | An **overload** failure with a transcript above `maxContextResume` is routed through the usage deadline (`receivedAt + 5 h`) and then finishes as `skipped-context`. Overload should retry with the short backoff, and never wait five hours. |
| F4 | medium | `src/waiter.js` probe evaluation | Success is decided by regex over stdout+stderr. A successful `--output-format json` result whose assistant text merely mentions "rate limit" is misclassified as still-limited. The JSON envelope (`is_error`, `subtype`, `result`) is ignored. |
| F5 | medium | `src/waiter.js` speculative probes | With a **trusted** parsed reset time the waiter still probes hourly before the deadline. Each probe is a full headless turn; in `hybrid` mode an early success silently takes the headless path instead of the visible terminal the user configured. Probing before a provider-announced time buys nothing. |
| F6 | medium | `src/core.js` `resetEpoch` | Dated form without a year rolls to next year when the date already passed (e.g. a stale "resets Oct 9" seen on Oct 10) and is then trusted for ~365 days. Compact relative forms (`2h 30m`, `2h30m`, `1 hr 5 min`) and the `usage limit reached|<epoch>` form are not parsed. |
| F7 | medium | `src/waiter.js` / `src/dashboard.js` | Headless `claude -p` denies every tool that needs permission unless a permission mode is supplied. The session registry already records the interactive session's `permissionMode`, but resumes never use it, so default-config headless continuations mostly do nothing. |
| F8 | medium | `src/hook.js` `saveEvent` | A second `StopFailure` for a session whose pending record exists but whose waiter died is ignored until the next `SessionStart` reconcile. |
| F9 | low | `src/codex.js` `streamCodex` | Thread id is extracted per chunk; a JSONL line split across chunks loses it and the resume falls back to `--last`. |
| F10 | low | `src/store.js` `writeAtomic` | Temp name is `path.pid`; two overlapping writes in one process (the fire-and-forget `onSpawn` write) share it. |
| F11 | low | `src/dashboard.js` | No `Host` header check (DNS-rebinding exposes `/api` snapshots); `done/` is never pruned; transcript tails are read for every session even though only 30 are shown; the recursive `~/.claude/projects` listing is repeated per session. |
| F12 | low | `src/store.js` `openTerminal` | Linux uses only `x-terminal-emulator -e`; gnome-terminal wants `--`, and `$TERMINAL` is ignored. |
| F13 | doc | `README.md`, `src/hook.js` `ralph` | Claude Code caps consecutive Stop-hook continuations at 8; `ralphMaxTurns` above 8 cannot take effect within one user turn. Not documented. |
| F14 | low | `src/hook.js` `startWaiter` | No `windowsHide: true` on the detached waiter spawn. |

Non-goals for this pass (record in README "Roadmap"): launchd/systemd boot
recovery, interactive Codex, verifying the outcome of the visible-terminal path.

---

## 1. Work items

Do them in order. Each item ends with `node --test` green. Commit after each
numbered group with a message that names the item (e.g. `waiter: fixed deadline
state machine (P0-2)`). Do **not** push; the reviewer pushes.

### P0-1  Test script + CI  (F1)

- `package.json`: `"test": "node --test"`.
- Add `.github/workflows/ci.yml`: on push/PR, matrix `node: [20, 22]` ×
  `os: [ubuntu-latest, windows-latest, macos-latest]`, steps: checkout,
  setup-node, `npm test`. Set `timeout-minutes: 10`.
- Acceptance: `npm test` passes locally on the installed Node 22.

### P0-2  Waiter deadline state machine  (F2, F3, F5)

Rewrite the scheduling part of `wait()` in `src/waiter.js` around these rules.
Keep the file layout and exported names (`claimUsageProbe`, `shouldOpenTerminal`,
`wait`); tests import them.

Definitions

- `deadline`: the moment at or after which the waiter is allowed to act on a
  usage limit. Fixed at start, changes only on new provider information.
- `trusted`: whether `deadline` came from a parsed provider time.
- `attempts` (persisted as `state.attempts`): failures **at or after** the
  deadline. Only these count towards `maxAttempts`.
- `probes` (persisted): total headless probes, informational.

Initial deadline (`initialDeadline`)

1. If the pending record has `resetParsed === true` and a finite `resetHint`,
   use `resetHint` (the hook already parsed it; tests set this field directly).
2. Else if `resetParsed` is absent (legacy record), re-parse `state.details`
   with `now = receivedAt`.
3. Else use `resetHint || receivedAt + fallbackMs`, untrusted.
4. Sanity cap: a parsed time more than **8 days** in the future is treated as
   untrusted (`receivedAt + fallbackMs`). Log `reset hint ignored (too far)`.
5. Add `marginMs`.
6. For `kind === 'overload'` the deadline is `receivedAt` (immediately
   eligible); the overload backoff array controls `until`.

Sleeping

- Sleep in `CHUNK` slices, re-reading the pending file each slice so `cancel`
  still works (existing behaviour, existing test).
- Usage, trusted: `until = deadline`. No probe before the deadline.
- Usage, untrusted: `until = min(deadline, now + jitter(usagePollMs))`
  (existing `nextUsageCheck`). These are *speculative* probes.
- Overload: `until = now + jitter(overloadMs[min(attempts, len-1)])`.

Acting when `now >= until`

1. Usage: claim the account gate (`claimUsageProbe`) as today. If not claimed,
   sleep until `gate.nextTry`.
2. If `shouldOpenTerminal(kind, mode, deadline)` → open the terminal (existing
   code) and finish `opened`. Extend `shouldOpenTerminal` so that an
   **overload with an oversized transcript** may also open a terminal when a
   desktop is available (headless is not allowed for it).
3. If oversized and we would go headless now → finish `skipped-context`
   immediately (no waiting for a usage deadline for overload; for usage this
   can only happen at/after the deadline because of the sleeping rules).
4. Otherwise run the headless probe (see P0-3 for result evaluation).
   - Success → finish `resumed` (gate spacing as today).
   - Usage failure, `now < deadline` (speculative): do **not** increment
     `attempts`. If the output parses a reset time, adopt it as the new
     trusted deadline (same 8-day cap). Re-derive `until` from the sleeping
     rules.
   - Usage failure, `now >= deadline`: increment `attempts`. If the output
     parses → `deadline = parsed + marginMs`, trusted. Else → `deadline =
     now + jitter(usagePollMs)`, untrusted (so the next probe is one poll
     away and also counts). Set `until = deadline`.
   - Overload failure: increment `attempts`, `until` from the overload
     backoff. If a usage kind flips to overload or back, update `state.kind`
     as today.
5. `attempts >= maxAttempts` → finish `gave-up` (existing notify text).

Gate writes (`setUsageGate`) stay where they are: after a terminal open,
after a resumed probe, after a usage-failed probe.

Tests to add in `test/waiter.test.js` (use the existing shim pattern; the
shim can append a timestamp to `shim-calls.txt`):

- trusted deadline: with `resetParsed: true, resetHint: now + 400` and
  `usagePollMs: 50`, the shim is first called no earlier than `now + 400`
  (i.e. no speculative probes), and the result is `resumed`.
- untrusted deadline: with `resetParsed: false`, `resetHint: 0`,
  `fallbackMs: 300`, `usagePollMs: 50`, `maxAttempts: 1` and the
  limited shim, the waiter probes several times before the deadline without
  giving up, and finishes `gave-up` only after the deadline with
  `attempts === 1` and `probes > 1`.
- overload + oversized, headless: finishes `skipped-context` in well under
  `fallbackMs` (set `fallbackMs` to 60 000 and assert elapsed < 2 000 ms).
- overload happy path: `kind: 'overload'`, ok shim → `resumed` within
  `overloadMs[0] * 2`.
- 8-day cap: a record with `resetParsed: true, resetHint: now + 30 days`
  and `fallbackMs: 100` resumes within ~1 s (proves the hint was ignored).

Also update `README.md` "How it works" step 3 to describe the new rules.

### P0-3  Headless probe result evaluation  (F4)

In `src/waiter.js`, after `runCommand`:

- Try `JSON.parse` on the trimmed stdout (Claude may print a single JSON
  object; if the output is JSONL take the last line that parses and has
  `type === 'result'`).
- If it parses and `is_error === false` → success, regardless of what the
  regexes see in `result`.
- If it parses and `is_error === true` → classify `failureKind(result +
  stderr)`; unknown kind counts as overload-style failure (existing
  `exit-<code>` behaviour).
- If it does not parse → current behaviour (`failureKind(stdout + stderr)`,
  exit code 0 with no kind = success).
- Store at most 1 000 chars of the failure text in `lastError` as today.
- Put the evaluation in a small exported pure function
  `evaluateProbe({ code, stdout, stderr })` → `{ ok, kind, text }` and unit
  test it in `test/core.test.js` (success JSON mentioning "rate limit" in
  `result` → `ok: true`; `is_error: true` with a limit banner → `kind:
  'usage'`; plain-text limit → `kind: 'usage'`).

### P0-4  Parser additions  (F6)

In `src/core.js` `resetEpoch`, before the existing fallback:

- Pipe-epoch form: `/limit reached\|(\d{10,13})/i` → seconds if 10 digits,
  milliseconds if 13. Return `max(now, epoch)`.
- Compact relative forms after a `reset|try again|wait|in` cue:
  `2h 30m`, `2h30m`, `2 hr 5 min`, `45m`, `90 mins` (the existing regex
  already handles `N minutes`/`N hours`; extend it to accept `h|hr|hrs|m|min|mins`
  abbreviations and an optional second component).
- Dated form without a year: if the computed epoch is more than 8 days in the
  future after the year roll, return `NaN` (untrusted) instead. Keep the
  existing behaviour for dates with an explicit year.

Add fixtures to `test/fixtures/banners.json` (`parses: true` where relevant):
`Claude AI usage limit reached|1893456000`, `resets in 2h 30m`,
`try again in 1 hr 5 min`, `usage limit · resets in 45m`.
Add exact-value assertions in `test/core.test.js` for the epoch form and one
compact form. All 16 existing fixtures must still pass.

### P0-5  Small correctness fixes  (F8, F9, F10, F14)

- `src/hook.js` `saveEvent`: when a pending record exists, return `undefined`
  only if its `waiterPid` or `probePid` is alive or it is younger than 120 s;
  otherwise re-arm by spawning a waiter for it, log `rearm session=…`, and
  still return `undefined` (no new record). Factor the "is this pending
  record owned by a live process" check out of `reconcile` and reuse it.
  Test: write a pending record with a dead `waiterPid` and `receivedAt` 5 min
  ago, call `saveEvent` for the same session, expect a `done/` record to
  appear (`resumed`) within the usual polling loop.
- `src/hook.js` `startWaiter`: add `windowsHide: true`.
- `src/codex.js` `streamCodex`: on exit, `thread ||= readCodexJson(tail).thread`.
- `src/store.js` `writeAtomic`: temp name `${path}.${process.pid}.${counter++}.${random}`.

### P1-1  Inherit the session's permission mode  (F7)

- New config key `inheritPermissionMode` (default `true`, boolean) in
  `defaults` and `loadConfig`.
- Helper in `src/store.js`: `resumeArgv(config, session, registry)` returns
  `[...config.claudeCmd, '--resume', session, ...maybe ['--permission-mode',
  mode]]` where `mode = registry?.permissionMode`, added only when
  `inheritPermissionMode` is on, `mode` is one of `acceptEdits | plan | auto |
  dontAsk | bypassPermissions`, and `config.claudeCmd` does not already contain
  `--permission-mode`. Unit test it.
- Use it in `src/waiter.js` (both the terminal open and the headless probe;
  read `sessions/<id>.json` once at the start of `wait`) and in
  `src/dashboard.js` `openSessionTerminal`.
- README: document the key, and say plainly that a `bypassPermissions`
  session resumes with `bypassPermissions`; set the key to `false` to opt out.

### P1-2  Warn when the original terminal is still alive

At the moment of a resume (terminal or headless) in `src/waiter.js`: if the
session registry says `status: 'active'` and `claudePid` is alive, log
`original claude still running pid=… session=…` and include a sentence in the
notification (`Original terminal still open; close it to avoid two Claudes on
one transcript.` / `原终端仍在运行，请关闭它以免两个 Claude 同时写入同一会话。`).
Do not block the resume. Test the decision helper as a pure function.

### P1-3  Linux terminal fallback chain  (F12)

`src/store.js` `openTerminal` on Linux: try, in order, `$TERMINAL` (if set),
`x-terminal-emulator -e …`, `gnome-terminal -- …`, `konsole -e …`,
`xfce4-terminal -x …`, `kitty …`, `alacritty -e …`, `xterm -e …`. Spawn the
first candidate; on the `error` event with `ENOENT`, try the next; reject with
the last error when all fail. Keep the returned promise/pid contract. Add a
unit test that injects a candidate list containing a non-existent binary first
and `process.execPath -e ""` second and asserts the second one spawns
(export a small `openWithCandidates(candidates, cwd)` for this).

### P1-4  Dashboard hardening and housekeeping  (F11)

- Reject any request whose `Host` header is not
  `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` with 403 before
  routing. Test with a fetch that sets `Host: evil.example:<port>` → 403
  (Node's `fetch` allows setting `Host`? If not, use `http.request`).
- Prune `done/`: keep the newest 100 records and delete records whose
  `finishedAt` is older than 30 days. Run it from the waiter's `finish` and
  from the CLI `status` command. Export `pruneDone()` from `src/store.js`
  and unit test it.
- `buildSnapshot`: stat transcripts and sort first, then read activity only
  for the 30 sessions that are returned.
- Cache the recursive `~/.claude/projects` listing once for 60 s instead of
  per session.

### P1-5  Locale override and Ralph cap  (F13)

- `src/i18n.js`: honour `TASKWAKE_LANG` (`zh` → Chinese, anything else →
  English) before the Intl locale. Test.
- `src/hook.js` `ralph`: clamp the effective turn limit to
  `min(config.ralphMaxTurns, 8)` and log once when clamping; README: explain
  the 8-consecutive-continuation cap enforced by Claude Code and lower the
  documented example to `"ralphMaxTurns": 8`.

### P2-1  Overload attempt budget

- New config `overloadMaxAttempts` (integer ≥ 1, default `8`). Overload
  failures give up after this many failures instead of `maxAttempts`; the
  backoff index clamps to the last `overloadMs` entry as today. Document it.
  Test: overload with the always-failing shim and `overloadMaxAttempts: 3`
  finishes `gave-up` with `attempts === 3`.

### P2-2  Docs and version

- README: update the config table (`inheritPermissionMode`,
  `overloadMaxAttempts`, `TASKWAKE_LANG`), the "How it works" retry
  description, the Ralph cap, and add a short "Roadmap / not yet" list for
  the non-goals above. Remove any claim the code no longer matches.
- Add `CHANGELOG.md` with a `1.3.0` entry summarising the items above.
- Bump `version` to `1.3.0` in `package.json` and `.claude-plugin/plugin.json`.

---

## 2. Constraints for the implementer

- Plain ESM, no dependencies, no build step, Node 20 compatible APIs only.
- Keep the terse style of the codebase; no speculative abstractions.
- Every behaviour change ships with a test in `test/`. Prefer pure helpers
  that can be unit-tested over timing-heavy subprocess tests; when a timing
  test is unavoidable keep it under two seconds.
- `node --test` must pass after every commit. Run it at least three times
  at the end to shake out flakiness in the timing tests.
- Do not touch `hooks/hooks.json` field names or the plugin manifests
  beyond the version bump.
- Do not push. Leave the branch with clean, per-item commits for review.
