# TaskWake

Re-wakes Claude Code sessions when a usage window resets. No tmux, no terminal
scraping, no keystroke injection — a Claude Code **plugin** whose `StopFailure`
hook records the interrupted session and a small detached waiter resumes the
exact transcript headlessly with `claude --resume <session-id> -p`. Works
natively on Windows, macOS, and Linux.

It does not bypass quota. It waits for the published reset, then continues
headlessly; this also requires Agent SDK credit (see Cost policy).

TaskWake automatically uses Simplified Chinese when the operating system locale starts
with `zh`; every other locale uses English. This applies to the dashboard, CLI,
notifications, and autonomous continuation prompts.

## Install

Requires Node.js 20+ and Claude Code. From any terminal (PowerShell, cmd, bash):

```sh
# from a local checkout (use your actual path):
claude plugin marketplace add C:\path\to\taskwake     # or /path/to/taskwake
# or from a git remote:
# claude plugin marketplace add https://github.com/<you>/taskwake

claude plugin install taskwake@taskwake
```

Verify, then **start a new Claude Code session** (hooks are loaded at session start):

```sh
claude plugin details taskwake   # should list Stop, SessionStart, SessionEnd, StopFailure
```

On Windows, install recovery once from an Administrator terminal so pending waiters are re-armed 30 seconds
after a reboot and checked every 5 minutes even when nobody logs in:

```sh
node bin/taskwake.js install-scheduler
```

That's it — no shell wrappers, no rc files, no tmux, no `source ~/.bashrc`.
The legacy `rewake` command, `REWAKE_*` environment variables, and existing
`~/.rewake*` state remain compatible after the TaskWake rebrand.

Troubleshooting:

- `Marketplace taskwake already exists` — it's already added; go straight to `claude plugin install taskwake@taskwake`.
- Nothing happens on a rate limit? Run `/taskwake:logs` — every decision is logged to `~/.taskwake/taskwake.log`.

## How it works

1. A rate limit / overload kills a turn → Claude Code fires the `StopFailure`
   hook with the session id and error details.
2. taskwake records the session under `~/.taskwake/pending/` and spawns one
   short-lived waiter process (no daemon).
3. Usage waiters share one account-level gate. They probe at most once per hour
   (with jitter) or at the parsed reset time, whichever comes first. Parse failures
   fall back to the 5-hour window, then **probe**: `claude --resume <id> -p "Continue from
   the interruption."` — if still limited, it re-parses and re-waits, bounded
   by `maxAttempts`.
4. On success you get a desktop notification. Reopen the session interactively
   anytime with `claude --resume <session-id>`.
5. Multi-session aware: `SessionStart` registers each Claude session and also repairs
   orphaned waiters. `SessionEnd` marks clean exits. On Windows the optional Task Scheduler
   entry repairs pending work after boot and every 5 minutes without login.

Honest limitations: the resumed work continues in the transcript headlessly;
your original terminal screen is not revived. The dashboard below shows live transcript
activity but is not an interactive Claude terminal. Boot recovery is currently implemented
only for Windows. If the machine is powered off at the reset time, continuation runs
after it boots; software cannot run while the machine is off.

## Multi-session dashboard

Open a read-only local control room:

```sh
node bin/taskwake.js dashboard
# or, after npm install -g .
taskwake dashboard
```

It listens only on `127.0.0.1:4178`, opens the default browser, and refreshes every
2 seconds. It merges active Claude sessions, pending limit waiters, running headless
continuations, Ralph turns, recent transcript tools/messages, and the TaskWake log.
Pass another port as the first argument or use `--no-open` to keep the browser closed.

Sessions started after v0.5.0 are registered automatically; older rate-limited sessions
still appear from their pending state. If two active Claude sessions point at the same
working directory, the dashboard warns about concurrent writes. It reports the risk but
does not stop or serialize either session.

## Autonomous Ralph mode

Ralph mode is opt-in. With `"ralph": true`, the bounded `Stop` hook applies to normal
interactive Claude sessions and headless sessions resumed by taskwake. Claude auto mode
handles tool permissions; Ralph finishes the current task and then selects the next safe
local task implied by `TODO.md`, `REVIEW_AND_HANDOFF.md`, `GAME_DESIGN.md`, tests, or
the working tree.

```json
{
  "claudeCmd": ["claude", "--permission-mode", "auto"],
  "ralph": true,
  "ralphMaxTurns": 20
}
```

Put this in `~/.taskwake.json`. Ralph continues in the same Claude session; it does not
create a fresh chat. The loop stops when Claude emits `[RALPH_DONE]`, reaches
`ralphMaxTurns`, or hits another limit; a later taskwake resumes the same bounded loop.
It never instructs Claude to modify global Claude settings, deploy, publish, push, change
credentials, spend money, mass-kill processes, or invent product scope. Claude's native
`/goal` remains optional and works alongside the Ralph hook.

## Cost policy

Auto-resume is not free: after a long wait the prompt cache is cold and the
resume re-reads the whole transcript at full input price.

Anthropic announced on May 14, 2026 that headless usage (`claude -p`, the
Agent SDK, GitHub Actions) would move off the Pro/Max/Team/Enterprise
subscription pools onto a separate monthly dollar credit starting June 15,
2026 — but **paused that change on June 15, the day it was due to take
effect**. As of this writing, headless `claude -p` continuations still draw
on the same subscription window as interactive use; Anthropic has said an
updated plan will be shared before anything takes effect. This could change
without notice — if a revived split ships, every taskwake resume (which is
inherently headless) would start costing API dollars instead of subscription
quota. Defaults:

- 5-hour-class limits: auto-resume.
- Weekly limits: notify only (`weeklyPolicy: "resume"` to override).
- Auto-resumes in the trailing 7 days at or above `weeklyResumeCeiling`
  (default 50): notify only, to keep an all-night retry loop from quietly
  burning most of the weekly window before you notice.
- Transcripts over `maxContextResume` bytes (default 2 MB) **or** an
  estimated `maxContextResumeTokens` (default 200,000, derived from the
  transcript's byte size — a rough, deliberately conservative estimate):
  notify only.

## Commands

Inside Claude Code (no extra setup): `/taskwake:status`, `/taskwake:logs`,
`/taskwake:cancel <id>`.

The shell CLI is optional and needs a one-time `npm install -g .` from this
repo (plugin install alone does not put `taskwake` on PATH):

```text
taskwake status              list pending and recent auto-resumes
taskwake logs                recent decision log
taskwake dashboard [port]    local multi-session control room
taskwake cancel <session>    cancel a pending auto-resume
taskwake install-scheduler   recover waiters after boot and every 5m
taskwake uninstall-scheduler remove Windows boot recovery
taskwake run codex exec …    Codex batch with usage-limit retry
```

## Codex

The stable Codex path is batch: `taskwake run codex exec …` streams output
through live, and on a usage limit waits for the reset and continues the same
thread via `codex exec resume`. Interactive Codex has no hook equivalent and
is out of scope until the app-server rate-limit protocol stabilizes.
`--ephemeral` threads cannot be resumed.

## Configuration

Optional global config at `~/.taskwake.json`. A `.taskwake.json` in a
project's working directory is layered on top of the global config for
sessions in that directory — use it to opt one project in or out of `ralph`
(or any other field) without changing the machine-wide default.

| field              | default                              |
|--------------------|--------------------------------------|
| `retryText`        | `"Continue from the interruption."`  |
| `marginMs`         | `60000`                              |
| `fallbackMs`       | `18000000` (5 h)                     |
| `usagePollMs`      | `3600000` (1 h, shared across sessions) |
| `usageResumeSpacingMs` | `300000` (5 min between resumed sessions) |
| `maxAttempts`      | `4`                                  |
| `overloadMs`       | `[30000, 60000, 120000, 240000, 300000]` |
| `maxContextResume` | `2000000` (bytes)                    |
| `maxContextResumeTokens` | `200000` (rough estimate from transcript bytes) |
| `weeklyResumeCeiling` | `50` (auto-resumes per rolling 7 days before falling back to notify-only; `0` disables) |
| `weeklyPolicy`     | `"notify"` (`"resume"` to auto-resume) |
| `claudeCmd`        | `["claude"]`                         |
| `ralph`            | `false`                                |
| `ralphMaxTurns`    | `20`                                   |
| `ralphTaskFiles`   | `["TODO.md", "REVIEW_AND_HANDOFF.md", "GAME_DESIGN.md"]` |
| `notify`           | `"toast"` (`"none"` to disable)      |

**Permission mode matters.** `claudeCmd` defaults to `["claude"]`, which runs
the headless resume probe under Claude Code's default permission mode. In
`-p` mode there is no one to answer a permission prompt, so tool calls can be
silently denied — the resumed turn then just narrates and exits 0, and
taskwake reports success even though no real work happened (it does try to
flag this heuristically as `resumed-idle` when the reply reads like a
permission block, but that detection isn't exhaustive). If you want resumes
to actually finish work unattended, set a non-interactive permission mode
explicitly, e.g.:

```json
{ "claudeCmd": ["claude", "--permission-mode", "acceptEdits"] }
```

State lives in `~/.taskwake/` (flat JSON files; delete the directory to reset).

## Acknowledgements

Inspired by, and portions derived from,
[cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry) (MIT).
taskwake replaces its tmux-scraping architecture with hook-driven headless resume.
