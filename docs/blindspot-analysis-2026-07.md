# TaskWake Blindspot Analysis & Execution Plan

**Date:** 2026-07-18 · **Scope:** research synthesis only — no code changes were made.

> **Update 2026-07-18 (implementation pass):** Phase 1 (§8) has been implemented, scoped to
> correctness/safety fixes that don't require a live account: the `error_type`/`error`
> precedence bug and `error_details`-object stringification bug (§2.2) are fixed with
> defensive handling of both plausible payload shapes, since Phase 0's live capture was
> deliberately deferred (see below); classification now prefers the structured
> `--output-format json` result over raw-text scanning (§2.5); bricked-session (#76008-style)
> and permission-stalled "success theater" (§2.6) detection were added; the byte-based context
> gate got a token-estimate sibling (§4); a rolling-7-day weekly-resume-budget ceiling was
> added (§4); Ralph and other settings gained a per-project `.taskwake.json` overlay (§4);
> the dashboard gained a Host-header allowlist and a per-launch token (§2.7); and the README's
> now-incorrect billing claim was corrected (§5.1). All 39 tests pass (`node --test
> test/core.test.js test/waiter.test.js`; the bare `node --test test/` directory-glob form
> fails in at least one sandboxed environment for reasons unrelated to this project — verified
> before any change was made).
>
> **Deliberately NOT done in this pass, and still open:** Phase 0's empirical capture (§2.1,
> §2.3 — whether subscription seat limits actually fire StopFailure, and whether `--resume -p`
> truly preserves the session id in practice) still requires a live account and was explicitly
> deferred rather than guessed at; the field-precedence fix is written defensively for exactly
> this reason. Phases 2–3 (quota governor, checkpoint-handoff resume, verified-resume
> reporting, cross-provider handoff, etc.) were not started. The LICENSE upstream-copyright
> sync (§5.4) was skipped rather than guessed at without re-fetching the upstream file.
**Inputs:** full source read of this repo; Claude Code official docs (code.claude.com, fetched
2026-07-18); GitHub API data on ~25 competing tools (exact stars/licenses/push dates as of
2026-07-18); anthropics/claude-code and openai/codex issue trackers; press coverage of the
2025–2026 Anthropic rate-limit changes.

**Evidence tags:** `[V]` verified against a fetched primary source · `[V-api]` verified via
GitHub API · `[U]` search-snippet/secondary-source only · `[CODE]` verified by reading this
repo · `[OPEN]` cannot be resolved from documentation — needs the empirical capture work in
Phase 0 before anyone builds on it.

---

## 0. Executive summary

TaskWake's architecture (StopFailure hook → pending record → detached waiter → headless
`claude --resume <id> -p`) is **directionally validated**: the hook exists, plugin exec-form
hooks with `args` are documented, `--resume -p` is documented to continue the same session,
and native Claude Code still has **no** auto-resume-on-usage-limit (feature requests are
closed as duplicates without shipping) `[V]`.

But the pass found four findings that individually change what should be built next:

1. **Two likely contract bugs make the core path dead or degraded against the documented
   StopFailure payload** (`error` message string shadows `error_type`; `error_details` object
   stringified to `[object Object]`, discarding `retry_after_seconds`). Nothing in the test
   suite could have caught this because every fixture is hand-written, not captured. §2, §3.
2. **It is undocumented whether subscription 5-hour/weekly seat limits fire StopFailure at
   all** — docs describe seat-limit exhaustion as a UI message, while StopFailure fires on
   "API errors". If seat limits don't fire the hook, TaskWake's headline scenario never
   triggers and only API-key 429/overload paths work. `[OPEN]` — this is the single most
   important thing to verify empirically before writing any more code. §2.1.
3. **The README's cost-policy section is factually wrong today and names the project's biggest
   existential risk.** The "Agent SDK credit" split (headless `claude -p` billed separately
   from the subscription) was announced May 14, 2026 and **paused by Anthropic on June 15,
   2026, the day it was due to take effect** — headless usage still draws from the
   subscription right now. If a revived split ships, TaskWake's *headless* resume starts
   costing API dollars while *interactive* resumes stay on the subscription — inverting the
   architecture's economics. §5.1.
4. **The Ralph-mode niche is now natively served** (`/goal`, `/loop` + scheduled tasks, and an
   official `ralph-wiggum` plugin in anthropics/claude-code), and the bare
   wake-at-reset niche is crowded (~15 tools; the closest competitor, `unsnooze`, uses the
   same StopFailure hook and iterates weekly). The defensible ground is the layer nobody
   ships: **quota-aware resume policy + checkpoint-quality resume + cross-provider handoff**.
   §6, §7.

---

## 1. What TaskWake is today (ground truth from source)

- `hooks/hooks.json` registers `Stop` (ralph), `SessionStart` (track + reconcile),
  `SessionEnd` (mark ended), `StopFailure` matcher `rate_limit|overloaded|server_error`
  (record + spawn waiter). Exec-form `command`+`args` with `${CLAUDE_PLUGIN_ROOT}`; 10s
  timeout. `[CODE]`
- `src/hook.js` — parses stdin JSON (BOM-tolerant), writes `~/.taskwake/pending/<session>.json`,
  spawns a detached `src/waiter.js`. `reconcile()` re-arms orphaned waiters from SessionStart.
  `ralph()` implements a bounded Stop-hook loop (`decision: "block"` + bilingual prompt).
- `src/waiter.js` — per-session process; account-wide probe gate via lock file
  (`usage-gate.json` + `wx` lock, 2-min stale takeover); skips weekly limits
  (`weeklyPolicy: "notify"`) and >2 MB transcripts; probes with
  `claude --resume <id> -p <retryText> --output-format json`; classifies the combined
  stdout+stderr with regexes; bounded by `maxAttempts`.
- `src/core.js` — banner classification (`failureKind`), weekly detection, reset-time parsing
  (relative / dated / clock-with-IANA-zone forms), Codex argv surgery.
- `src/codex.js` + `bin/taskwake.js run codex` — batch Codex wrapper: stream `codex exec`,
  detect usage banner in a rolling 64 KB tail, wait, `codex exec resume --json <thread>`.
- `src/dashboard.js`/`dashboard-page.js` — read-only localhost dashboard on 127.0.0.1:4178.
- Tests: unit tests for parsing/classification and subprocess end-to-end tests **against a
  Node shim standing in for `claude`** — no test touches the real CLI contract.

---

## 2. Unknown unknowns — contract risks the tests cannot see

### 2.1 Does a subscription seat limit fire StopFailure at all? `[OPEN]` — existential

The docs confirm StopFailure fires "when the turn ends due to an API error", with matchers
including `rate_limit`, `overloaded`, `server_error` `[V]`. But `/en/costs` describes
"You've hit your session limit / weekly limit" as **UI-level banner messages** on
subscription seats, and no doc states these fire any hook. Two adjacent facts raise the
concern from theoretical to probable-enough-to-block-everything:

- Claude Code's changelog explicitly distinguishes "transient server rate-limit errors
  (**429s unrelated to your usage limit**)" — which it retries natively — from usage-limit
  stops, which it deliberately does not `[V]`.
- Open issues #67754 / #67748 ask Anthropic to *add* usage-limit state exposure and
  graceful-shutdown hooks — requests that would be redundant if StopFailure already fired
  reliably on seat limits `[V-api]`.

Counter-evidence: `unsnooze` (active competitor, 2026-07) lists the StopFailure hook as one
of its detection channels *alongside* pane scraping and transcript watching `[V README]` —
the fact that it needs three channels suggests the hook alone is not sufficient.

**Consequence if the hook doesn't fire on seat limits:** TaskWake silently does nothing in
its headline scenario, and no test would ever notice, because every test injects a synthetic
event. **Phase 0 exists to answer this question first.**

### 2.2 StopFailure payload field-shape bugs `[CODE + V-docs, empirical confirmation needed]`

The documented payload is:

```json
{ "hook_event_name": "StopFailure",
  "error_type": "rate_limit",
  "error": "Rate limit exceeded. Please try again in 60 seconds.",
  "error_details": { "retry_after_seconds": 60 },
  "last_assistant_message": "…", "session_id": "…", "transcript_path": "…", "cwd": "…" }
```

- **Bug A — `src/hook.js:16`:** `const errorType = input?.error ?? input?.error_type;`
  Per the schema, `error` is the *human-readable message*, `error_type` is the matcher value.
  When both are present, the message string wins, `kinds["Rate limit exceeded…"]` is
  `undefined`, and `saveEvent` returns without recording anything — **the waiter is never
  armed**. The matcher in hooks.json would still have fired the hook; it just does nothing.
- **Bug B — `src/hook.js:21`:** `[input.error_details, input.last_assistant_message].join('\n')`
  with `error_details` as an **object** yields `"[object Object]"`. The one machine-readable
  reset signal (`retry_after_seconds`) is discarded, and `resetEpoch()` regex-parses garbage,
  silently falling into the 5-hour fallback.

Caveat: the doc example could itself be paraphrased; the fix must be written against
**captured** payloads (Phase 0), then handle *both* shapes defensively.

### 2.3 `--resume` session-identity drift — docs vs. reality `[OPEN]`

Docs say `claude -p --resume <id>` continues the **same** session id unless `--fork-session`
is passed `[V /en/headless]`. But the issue tracker says otherwise in practice:

- #10806: "`--resume` creates new session_id instead of preserving original" — breaking
  session-ID-keyed automation, which is exactly TaskWake's design (pending files, done
  records, and user-facing "reopen: `claude --resume <original-id>`" advice). `[V-api]`
- #23692: forked sessions missing from the `/resume` picker; v2.1.90 hid `-p`/SDK sessions
  from the interactive picker entirely (#42311) `[U]`.

**Consequence:** after a successful headless continuation, the user's
`claude --resume <original-id>` may open a transcript **without the continuation in it**, or
the continuation may live in a session invisible to the picker. Every user-visible promise
TaskWake makes ("reopen the session anytime") hinges on this. Needs empirical capture.

### 2.4 Resume quality is a known-broken area upstream

The highest-signal issue found in the entire tracker is exactly TaskWake's path:

- #3138 (open since Jul 2025, 44 👍): resume fails to maintain conversation context after
  usage/context-limit interruptions — "user must re-explain entire project context". `[V-api]`
- #76008 / #68553: `400 diagnostics.previous_message_id` after usage-limit resume
  **permanently bricks** the session. TaskWake's waiter would classify this nonzero exit as
  "overload", and retry a bricked session up to `maxAttempts` times. `[V-api]`
- #69452: prompt cache **not applied** on resume; #69568: resume re-sends completed-turn
  thinking signatures, inflating context. Auto-resuming a large session can burn a meaningful
  slice of the freshly reset window immediately — and TaskWake's only guard is a crude
  2 MB *byte* gate (`maxContextResume`), not a token estimate. `[V-api + CODE]`

### 2.5 Self-referential failure classification `[CODE]`

`waiter.js:135-137` scans the **entire output of the resumed turn** with `failureKind()`.
The `usageWords` regexes include generic phrases (`/\btry again (?:in|at)\b/i`,
`/\brate limit(?:ed)?\b…\breset/i`). Any successful continuation whose *content* legitimately
discusses rate limits — dogfooding TaskWake, building a rate limiter, a test suite printing
"try again in 5 seconds" — is misclassified as still-limited. The real work completes and
spends tokens, but TaskWake burns an attempt, reschedules, and eventually reports `gave-up`.
The structured alternative already exists: `--output-format stream-json` emits
`system/api_retry` events carrying `error` category and `retry_delay_ms`, and the final
result object distinguishes success subtypes `[V /en/cli-reference]`. Nobody in the
competitor field uses it either — cheap differentiation.

### 2.6 Success theater: exit 0 ≠ useful work `[CODE]`

`result.code === 0 && !kind` ⇒ `status: 'resumed'` + a success notification. But the default
probe command is bare `claude` (`claudeCmd: ["claude"]`) with the **default permission
mode**; in `-p` mode unanswered permission prompts mean tools are denied and the model often
just narrates and stops — exit 0. The README's example config uses `--permission-mode auto`
(a valid mode `[V /en/permissions]`), but nothing warns that the *default* configuration
produces hollow "resumed" successes. There is no post-resume verification of any kind (did
files change? did tests pass? did the turn use tools at all?).

### 2.7 Other unknown unknowns worth logging

- **Chained-limit re-entry is safe but subtle:** `-p` runs load plugins/hooks by default
  (`--bare` skips) `[V /en/headless]`, so a headless continuation that itself hits a limit
  fires StopFailure again; `saveEvent` dedups on the existing pending file. Verified by
  reading, not by test — worth a Phase-0 case.
- **English-only banner parsing:** TaskWake localizes its own UI to zh, but `failureKind`/
  `resetEpoch` only match English banners. A zh-locale Claude Code (or any future localized
  CLI output) silently degrades to the 5-hour fallback. `[CODE]`
- **Single-machine gate:** the "account-level" probe gate is a local file; two machines on
  one account thunder-herd each other. `[CODE]`
- **Reboot recovery is Windows-only**, and on macOS/Linux recovery only happens when the user
  *starts a session* — i.e. the machine that rebooted overnight does nothing until the human
  returns, which is precisely the scenario the tool sells. launchd/systemd-user equivalents
  are absent. `[CODE]`
- **Windows `shellSpawn` strips embedded quotes and routes through cmd.exe** (`store.js:72-76`)
  — a config `retryText` containing quotes is silently corrupted, and `%VAR%` sequences are
  env-expanded by cmd. Low severity, config-owner-only input. `[CODE]`
- **Dashboard:** XSS-safe (`textContent` everywhere) but the HTTP server never validates the
  `Host` header → DNS-rebinding can read transcript excerpts from a hostile web page, and on
  shared multi-user machines any local user can read the dashboard (no auth token). `[CODE]`
- **Hook timeout is 10 seconds** (units confirmed as seconds `[V]`): `saveEvent` does
  stat + writes + spawn — fine normally, tight on cold Windows filesystems with AV scanning.

---

## 3. Misleading benchmark/test assumptions

1. **The suite tests TaskWake against TaskWake's own imagination.** Every StopFailure payload
   is synthesized by the tests (`error: 'rate_limit'` as the *type* — the same reading as Bug
   A, so the bug is invisible); `claude` is a Node shim that prints
   `{"type":"result","result":"ok"}`. Green tests are compatible with the plugin never
   working once in production. There is no captured-payload corpus, no contract test, no
   canary that runs against a real CLI version.
2. **`test/fixtures/banners.json` is hand-written, unversioned, and unattributed.** Banner
   wording demonstrably drifts across CLI releases; there is no record of which CLI version
   produced which string, so parser regressions can't be traced.
3. **"resumed" is counted as success with zero quality measurement.** No metric exists for:
   did the continuation do useful work, how many tokens did it cost, was the reset time
   parsed correctly vs. fallback, false-positive rate of `failureKind`. §8 defines the
   metrics an honest benchmark needs.
4. **The ambiguous-clock strategy silently spends money.** When am/pm is ambiguous,
   `resetEpoch` picks the *earlier* interpretation (core.js:111), meaning a deliberate early
   probe — but a "probe" is a full continuation attempt at full cost, not a cheap check. The
   code comment frames wrong parses as costing "one bounded extra wait"; they actually cost
   a paid turn plus an attempt out of `maxAttempts`.

---

## 4. Quality-loss risks of the current resume design

- **`"Continue from the interruption."` into a possibly mid-tool-call corpse of a turn** is
  the lowest-quality resume prompt possible, aggravated by upstream context-loss bugs
  (#3138). The ecosystem is converging on checkpoint files instead (Otsukare "pause at a safe
  checkpoint", claude-baton EOD summaries, snarktank/ralph's 21k★ "one story per fresh
  context" pattern) `[V-api]`.
- **Cold-cache resume of a huge transcript can immediately burn a large slice of the fresh
  window** (#69452, #69568) — and TaskWake resumes *multiple* sessions serially 5 minutes
  apart, then Ralph can add up to 20 autonomous turns per session. There is no global budget,
  no per-night cap, no cost estimate before resuming.
- **Weekly-cap acceleration:** `weeklyPolicy` only triggers when the *banner text* says
  weekly. Auto-resuming every 5-hour reset all week is exactly how you hit the weekly cap
  while asleep — after which "auto-resume" means waiting days. (HN threads confirm the weekly
  window is the binding constraint for heavy users `[U]`.) No tool of TaskWake's class
  projects weekly burn; that's an opportunity, not just a risk (§7.1).
- **Stale-world resumes:** a continuation firing hours later runs against a repo whose HEAD,
  branch, or dirty state may have changed. `unsnooze` ships "workspace fingerprinting"
  (hold resume if HEAD/dirty state changed) `[V README]`; TaskWake has nothing.
- **Ralph scope-bleed:** `ralph: true` lives in the **global** `~/.taskwake.json` and applies
  the continue-loop to every session in every project, including one-off Q&A sessions.
  The prompt hardcodes `TODO.md` / `GAME_DESIGN.md` conventions. There is no per-project
  opt-in and no check of the documented `stop_hook_active` input flag (bounded only by
  TaskWake's own turn counter file).

---

## 5. Provider-specific limitations & ToS exposure

### 5.1 The paused billing split — biggest external risk `[V-by-convergence]`

- May 14, 2026: Anthropic announced Agent SDK / `claude -p` / GitHub Actions usage would
  leave the Pro/Max subscription pools on June 15, 2026 for a separate monthly dollar credit
  billed at API rates.
- **June 15, 2026: the change was paused on the day it was due to take effect** (The New
  Stack; corroborated by ~10 outlets incl. Zed's blog; the support.claude.com article
  15036540 is the primary source but blocked fetching). Headless usage **currently still
  draws from the subscription**.
- **README impact:** the "Cost policy" section states the split as an in-effect fact
  ("Since June 15, 2026, Anthropic accounts `claude -p` against a separate monthly Agent SDK
  credit"). That is wrong as of 2026-07-18 and should be corrected to "announced and paused;
  may return".
- **Design impact:** if a revived split ships, every TaskWake resume costs API dollars while
  an *interactive* resume (pty/tmux keystroke into a live session — the approach TaskWake's
  README explicitly brags about not needing) would remain on subscription. The tmux-based
  competitors get this hedge accidentally. TaskWake should treat "resume transport"
  (headless `-p` vs. interactive pty) as a pluggable policy, not an identity. §7.5.

### 5.2 ToS reality `[V primary: code.claude.com/docs/en/legal-and-compliance]`

- Prohibited: third parties routing requests through users' Free/Pro/Max credentials —
  **not** TaskWake's pattern (it spawns the first-party binary under the user's own login).
- The operative constraint is the vague clause: limits "assume **ordinary, individual
  usage**", enforceable "without prior notice". Weekly limits were introduced (July 2025)
  explicitly to curb "running Claude Code continuously in the background, 24/7" — the exact
  pattern TaskWake + Ralph enables. No verified ban for an auto-resume tool driving the
  official CLI was found; the Jan 2026 OpenClaw ban wave targeted OAuth-tokens-inside-
  third-party-tools `[U]`. Residual risk: real but reputational/vague-clause, not
  documented enforcement.
- **Never build:** multi-account rotation (cux, GPL-3.0, does this) — it maps to the
  explicitly-cited "account sharing" enforcement rationale, and cux's GPL license is
  incompatible with this repo's MIT anyway.
- Timing note: the weekly-limit +50% promo was extended to **July 19, 2026 — the day after
  this analysis**. If limits snap back, demand for TaskWake-class tools spikes the same week.

### 5.3 Codex side

- `codex exec resume` exists (multiple independent confirmations; primary docs 403'd) and
  `--ephemeral` threads can't resume — matching TaskWake's implementation. `[U→strong]`
- openai/codex #21073 (fetched, open, no maintainer response) confirms no native auto-resume
  **and** reveals `UsageLimitReachedError.resets_at` is programmatically available in JSON
  output — cleaner than banner regexes; TaskWake's tail-scraping should migrate to it.
- TaskWake's Codex batch wrapper has essentially **one** competitor (unsnooze, pane-typing).
  This leg is more differentiated than the Claude leg and is currently buried at the bottom
  of the README.

### 5.4 Licensing — clean, with two notes

- `cheapestinference/claude-auto-retry` **exists, is MIT** (256★, active) `[V-api]`.
  TaskWake's LICENSE retains an upstream copyright line — MIT obligations satisfied. Verify
  the upstream's actual copyright-holder string matches the line used ("CheapestInference")
  and sync if upstream's LICENSE differs.
- Do not copy from `inulute/cux` (GPL-3.0) `[V-api]`.
- `unsnooze`, `nightshift`, `terryso/claude-auto-resume`, `snarktank/ralph`: all MIT — safe
  to study and borrow from with attribution.
- Marketplace naming: `taskwake@taskwake` has no collision found, but the plugin name is
  unregistered in any official marketplace; squatting risk is low priority.

---

## 6. Competitive map — where TaskWake actually stands

| Niche | State | Verdict for TaskWake |
|---|---|---|
| Bare wake-at-reset | ~15 tools; terryso 796★ (probe-by-polling, `-c`, skip-permissions), cheapestinference 256★ (tmux) | Crowded; hook architecture is better but not a moat |
| Hook-based multi-CLI resume | **unsnooze** 48★, 10 days old, weekly releases; StopFailure + pane-scraping + transcript-watching, ledger, dead-pane revival, workspace fingerprinting, context-cost guard | The direct threat; already ahead on robustness features |
| Quota-aware scheduling | nightshift 34★ (OAuth usage endpoint, pre-warm, bedtime queue) | Open — nobody closes measurement→policy loop |
| Ralph loops | snarktank/ralph 21,116★ + **native `/goal`, `/loop`, official ralph-wiggum plugin** | Lost to natives; keep thin, don't invest |
| Usage monitoring | ccusage 17,244★, Usage-Monitor 8,467★ | Don't compete; consume their data |
| Codex auto-resume | Only unsnooze (scraping) | **Underexploited TaskWake strength** |
| Cross-provider handoff | **Nobody** | Genuinely open |
| Multi-machine same-account coordination | Nobody (cux does multi-*account* = ToS-risky version) | Open, safe variant available |

Native-feature watch: Anthropic retries transient 429s natively, ships extra-usage credits
and usage bundles (its commercial answer to "don't stop me"), and closed auto-resume feature
requests without shipping. The waiting-for-reset niche stays open but could be nativized any
release — another reason the moat must be the policy/quality layer, not the wake-up call.

---

## 7. Differentiation thesis — the breakthrough is the policy layer

Every competitor (and TaskWake today) answers *"when can I resume?"*. Nobody answers
**"should I resume, with what context, at what cost, on which provider?"** That is the
defensible product:

1. **Quota-aware resume governor.** Fuse (a) the OAuth usage endpoint nightshift proved out
   (undocumented — wrap in a feature flag with graceful degradation), (b) `stream-json`
   `api_retry` events, (c) ccusage-style local JSONL accounting. Policy: resume now / defer /
   refuse ("this resume would burn the last 18% of your weekly window on a cold-cache 1.8 MB
   transcript"). Ship with a projected-weekly-burn model. **No tool does this.**
2. **Checkpoint-quality resume.** On StopFailure, the hook already holds
   `last_assistant_message` and the transcript path: write a structured handoff file (goal,
   state, next steps, touched files, git HEAD), and make the resume prompt reference it —
   optionally resuming into a **fresh** session seeded from the handoff instead of a
   cold-cache replay of a bricked transcript. Directly addresses the highest-voted upstream
   pain (#3138) and the cache-cost complaints (#69452).
3. **Verified resume.** After continuation: report *what actually happened* (tools used,
   files changed, tests run, tokens spent) in the notification instead of "Session resumed".
   Detect the permission-stall hollow success (§2.6). Nobody does post-resume verification.
4. **Cross-provider handoff.** TaskWake is the only tool with both a Claude and a Codex leg.
   "Claude weekly-capped → hand the checkpoint file to `codex exec` → reconcile at reset" is
   a genuinely novel capability, built from parts that already exist in this repo.
5. **Transport-pluggable resume** (headless `-p` today; interactive pty optional) as
   insurance against the paused billing split returning. §5.1.
6. **De-invest:** Ralph mode (delegate to native `/goal`; keep the config shim), usage
   dashboards beyond the current one, multi-account anything.

---

## 8. Execution plan (for the implementing agent)

Phases are ordered by information value; **do not skip Phase 0** — Phases 1+ change shape
depending on its findings.

### Phase 0 — Empirical contract capture (blocks everything)

Goal: replace assumptions with captured facts. Deliverable: `test/fixtures/captured/` corpus
+ a findings note, each entry tagged with CLI version.

0.1 Build a capture shim: a hook entry (added to a scratch settings.json, all events) that
    dumps raw stdin JSON to timestamped files. Run a real Claude Code under a low-limit
    account / forced-429 conditions (an API-key profile with a tiny rate limit makes 429s
    reproducible even when seat limits aren't).
0.2 Answer, with captures: (a) does a **seat** limit fire StopFailure, and with which
    `error_type`? (b) exact StopFailure field shapes (`error` vs `error_type`,
    `error_details` object shape); (c) does `claude -p --resume <id>` preserve the session
    id in the transcript store, or fork (#10806)? (d) exit code + stdout of a limited
    `-p` run in `--output-format json` and `stream-json` (capture the `api_retry` event);
    (e) does a permission-stalled `-p` turn exit 0, and what does its result JSON look like?
    (f) chained StopFailure inside a headless continuation (re-entry dedup).
0.3 Record CLI version → banner-string pairs into `banners.json` with provenance fields.
0.4 Write contract tests that run only when a real `claude` binary is present
    (`describe.skip` otherwise) so CI stays green but a canary exists.
Exit criteria: every `[OPEN]` in this doc resolved to CONFIRMED/CONTRADICTED with a capture
file. **If seat limits fire no hook:** pivot Phase 1 to a secondary detection channel
(transcript-tail watcher like unsnooze's, or a `SessionEnd`+usage-endpoint check) before
anything else.

### Phase 1 — Correctness (make the existing promise true)

1.1 Fix field precedence (`hook.js:16`): prefer `error_type`, fall back to `error` **only if**
    it matches a known type token; handle `error_details` as object or string; consume
    `retry_after_seconds` directly as the primary reset signal, regex text only as fallback.
1.2 Replace output-scraping success detection (`waiter.js:126-158`): use
    `--output-format stream-json`; classify from structured `api_retry` events and the final
    result object; treat the assistant's *content* as opaque. Kill the §2.5 false-positive
    class entirely. Keep regexes only for CLI versions predating structured output.
1.3 Detect hollow success: from the result JSON, check the turn used ≥1 tool or produced
    file changes; else report "resumed-but-idle" with remediation hint (permission mode).
    Detect the #76008 bricked-session `400 previous_message_id` signature and stop retrying
    it (`status: 'bricked'`, notify).
1.4 Correct the README cost-policy section (split announced-then-paused; current truth) and
    the notification wording pending the 0.2(c) fork answer.
1.5 Replace the byte gate with a token estimate (parse transcript JSONL, sum text lengths /
    use the usage fields present in result records); make the threshold context-window-aware.
1.6 Weekly-budget guard v0: even without the usage endpoint, count local resumes per
    rolling 7 days and warn/stop at a configurable ceiling.
1.7 Ralph hygiene: per-project opt-in (config in project dir or env), honor
    `stop_hook_active`, make the task-source file list configurable.
1.8 Small fixes: dashboard `Host` header check + random token in URL; document
    `claudeCmd` permission-mode requirement prominently; sync upstream copyright line.

### Phase 2 — Differentiators (in order)

2.1 Resume governor: usage-endpoint reader (feature-flagged, graceful when the endpoint
    changes) + policy engine (5h vs weekly budget, transcript-size cost estimate, configurable
    reserve floor like "never spend below 20% weekly"). CLI: `taskwake policy explain`.
2.2 Checkpoint handoff: StopFailure hook writes `~/.taskwake/handoff/<session>.md`
    (goal, last assistant message, git HEAD/dirty summary, next-step hints); resume prompt
    references it; optional `resumeMode: "fresh-context"` that starts a new session from the
    handoff instead of `--resume`. Add workspace fingerprint (HEAD + dirty hash) and hold
    resume with a notification if the workspace changed.
2.3 Verified-resume notification: diff summary (files changed, tests run if a verify command
    is configured, token/cost figures from result JSON).
2.4 Codex upgrade: parse `UsageLimitReachedError.resets_at` from `--json` events instead of
    tail regexes; promote the Codex leg in README.

### Phase 3 — Strategic bets (validate demand before building)

3.1 Cross-provider handoff prototype behind a flag: on weekly-cap, translate the checkpoint
    into a `codex exec` invocation; write a reconciliation note for the Claude session.
3.2 Interactive-resume transport (pty write into a live session, or spawn into tmux when
    available) as a config option — activate marketing only if the billing split revives.
3.3 macOS launchd / Linux systemd-user timer equivalents of the Windows scheduler.
3.4 Multi-machine same-account gate via a shared directory (Syncthing/Dropbox-friendly file
    protocol) — same-user only; never cross-account.

### Metrics (define before Phase 2; this is the honest benchmark)

- Trigger recall: % of real limit events that produced a pending record (needs Phase 0 shim
  kept as an opt-in telemetry hook).
- Resume utility: % of resumes with ≥1 tool call / file change; median tokens per resume;
  % hollow.
- Parse quality: % of resets parsed vs. fallback; median |parsed − actual| minutes.
- False-positive rate of failure classification (target ~0 after 1.2).
- Cost: tokens per resumed session; weekly-window share consumed autonomously.

### Standing guardrails

- Defaults stay conservative: bounded attempts, weekly = notify, budget floors on.
- Document the "ordinary, individual usage" ToS clause in the README; never ship
  multi-account features; never touch other users' credentials.
- Keep a native-feature watch (changelog diff per release) — if Anthropic ships native
  auto-resume, the wake-up layer is dead weight and the policy/checkpoint layer is the product.

---

## Appendix — key sources

Official docs: code.claude.com/docs/en/{hooks, hooks-guide, headless, cli-reference, costs,
errors, permissions, plugins, goal, scheduled-tasks, legal-and-compliance}.
Upstream issues: anthropics/claude-code #3138 #10806 #23692 #36320 #42311 #62788 #67748
#67754 #68553 #69452 #69568 #76008 #78224; openai/codex #21073 #28931 #14544 #10311.
Competitors (stars as of 2026-07-18): terryso/claude-auto-resume 796★ MIT ·
cheapestinference/claude-auto-retry 256★ MIT · benbasha/Claude-Autopilot 240★ MIT
(abandoned) · saaranshM/unsnooze 48★ MIT · inulute/cux 35★ **GPL-3.0** ·
dujunyi416/claude-nightshift 34★ MIT · snarktank/ralph 21,116★ MIT · ccusage/ccusage
17,244★ · Maciek-roboblog/Claude-Code-Usage-Monitor 8,467★ · smtg-ai/claude-squad 8,131★ ·
anthropics/claude-code plugins/ralph-wiggum (official).
Billing-split coverage: The New Stack "Anthropic pauses Claude Agent SDK subscription
change"; support.claude.com article 15036540; zed.dev/blog/anthropic-subscription-changes.
Rate-limit history: TechCrunch 2025-07-28; anthropic.com/news/higher-limits-spacex
(2026-05-06); Help Net Security 2026-07-13 (weekly promo extended to 2026-07-19).
