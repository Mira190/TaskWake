# Changelog

## 1.3.0

Waiter correctness
- Fixed-deadline state machine: a parsed (trusted) reset time is never probed early;
  without one, speculative probes before the 5-hour fallback no longer count towards
  `maxAttempts`, so an unparseable banner no longer gives up before the window ends.
  Parsed times more than 8 days ahead are ignored.
- Overload / server errors retry on the `overloadMs` backoff immediately and never wait
  a usage deadline; an oversized overload opens a visible terminal when possible,
  otherwise it is skipped at once. New `overloadMaxAttempts` (default 8).
- Headless probes are judged from Claude's JSON result envelope (`is_error`), so a
  successful answer that mentions "rate limit" is no longer treated as still limited.
- Resumes inherit the session's permission mode (`inheritPermissionMode`, default `true`;
  `plan` is not inherited because a headless plan-mode turn cannot do work).
- Headless probes run with `TASKWAKE_PROBE=<session>` so their own SessionStart/SessionEnd
  hooks do not overwrite the interactive session's registry entry.
- An overload that turns out to be a usage limit with an announced reset starts a fresh
  usage attempt budget instead of giving up on the overload count.
- A resume warns when the original Claude terminal is still running.
- A new `StopFailure` for a session whose waiter died re-arms the waiter from the fresh
  event's details, keeping the old counters.
- `writeAtomic` retries the final rename on Windows `EPERM`/`EBUSY`.

Parsing
- New reset forms: `usage limit reached|<epoch>`, `2h 30m`, `2h30m`, `1 hr 5 min`,
  `45m`, `90 mins`. Any parsed time more than 8 days ahead is treated as unparsed
  (this applies to every caller, including the Codex path).

Platform and dashboard
- Linux terminal fallback chain (`$TERMINAL`, x-terminal-emulator, gnome-terminal,
  konsole, xfce4-terminal, kitty, alacritty, xterm); a candidate that exits non-zero
  right away falls through to the next one.
- Dashboard rejects non-loopback `Host` headers, reads transcript activity only for the
  30 sessions shown, and caches the `~/.claude/projects` listing for 60 s.
- `done/` is pruned to the newest 100 records and 30 days.
- `TASKWAKE_LANG` overrides the system locale.
- Ralph continuations are clamped to Claude Code's cap of 8 consecutive Stop-hook blocks.

Fixes and hygiene
- `npm test` works on Node 22 (`node --test`); CI matrix for Node 20/22 on Linux,
  Windows, and macOS.
- Unique temp files for overlapping atomic writes; Codex thread ids split across
  output chunks are recovered; the detached waiter spawns with `windowsHide`.
