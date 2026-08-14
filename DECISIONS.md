# Decision Log

Newest first. Each entry: what was decided, why, and what would reverse it.

## 2026-08-14 — round 2 (NEXT_STEPS #3–#6 executables)

0a. **One `STATUSES` table in core.js drives every status surface** — priorities
    (dashboard sort), en/zh labels (CLI + dashboard API + embedded page, which now
    interpolates `statusLabels()` JSON into the template). Adding a status is a one-place
    change; unknown statuses fall back to the raw string / priority 9.
0b. **Workspace fingerprint hold, default ON (`workspacePolicy: "hold"`).** `saveEvent`
    captures `git HEAD + sha1(status --porcelain)` at interruption; the waiter re-checks
    right before any spend (after gate claim, before visible-open/probe) and finishes
    `skipped-workspace-changed` on mismatch. Both fingerprints must exist — non-git
    workspaces and vanished-git environments never hold. Reverse if: field data shows the
    hold fires mostly on the user's *own* expected changes (then flip default to `ignore`).
0c. **Gate handback times are bounded by the configured cadence**
    (`min(CHUNK, usagePollMs)`), after the review pass's absolute `+60s` handback stalled
    short-cadence configurations (KNOWN_FAILURES #3).
0d. **Resumed done-records carry `numTurns`/`costUsd` from the CLI result JSON and a
    `workspaceChanged` verdict** (git fingerprint before vs after the probe — hard evidence
    that complements the `looksIdle` text heuristic), surfaced in the notification and
    `taskwake status`. The pre-probe fingerprint is captured before `runCommand` even under
    `workspacePolicy: "ignore"` — a post-probe capture would compare a value to itself.
    Tools-used reporting remains open (NEXT_STEPS).
0e. **`done/` records pruned after 30 days during `reconcile`** — generous floor above the
    7-day ceiling window; event-driven like everything else, no timer.
0f. **`npm run lint`** = `node --check` over all JS plus a `vm.Script` parse of the
    dashboard page's embedded `<script>` (the merge-seam class `node --check` can't see).

## 2026-08-06 — improvement pass

1. **`npm test` uses bare `node --test`** (default glob), not a directory argument.
   Evidence: `node --test test/` fails on Node v22.22.2 with MODULE_NOT_FOUND (reproduced in
   a minimal fresh project; both with and without trailing slash), while bare invocation and
   explicit globs work. Reverse if: a future Node LTS makes directory args reliable *and*
   the default glob ever over-matches (it currently matches exactly `test/*.test.js`).

2. **Probe verdicts live in `core.classifyProbe`, and the benchmark scores that exact
   function.** A non-error JSON result with exit 0 is success outright — reply text is never
   banner-scanned (it may legitimately say "try again in 5 seconds"). Chosen over
   tightening the regexes because the regexes are *supposed* to be trigger-happy on real
   banners; the error was applying them to successful replies at all. Reverse if: a real CLI
   is observed emitting `is_error:false` + exit 0 while still limited (contract violation —
   would also need upstream escalation).

3. **Dashboard activity cache keyed by `(mtimeMs, size)` with a blunt 1,000-entry clear** —
   no TTL, no LRU. Simplest invalidation that is provably correct for append-only JSONL;
   guarded by a staleness regression test. Reverse if: transcripts are ever rewritten
   in-place same-size (would need content hashing), or memory profiling shows the bound too
   generous.

4. **The weekly resume ceiling counts `opened` (visible-terminal) outcomes as spend.**
   The hybrid path auto-submits `retryText` into the reopened session, so it consumes quota
   unattended exactly like a headless resume; exempting it would let the ceiling be bypassed
   by whichever machine has a desktop. Reverse if: upstream changes the visible open to NOT
   auto-submit a prompt (then `opened` becomes free and should stop counting).

5. **Both context gates kept (2 MB bytes AND 200k estimated tokens), with the token gate
   binding first at defaults** (200k × 4 B/token ≈ 800 KB effective threshold). Kept both
   because they fail differently: bytes is exact but meaningless, tokens is meaningful but
   estimated. Documented rather than "fixed" — tightening the byte default would silently
   change upstream behaviour mid-merge. Reverse if: Phase-0 capture yields real
   bytes-per-token ratios for transcripts (then fold into one calibrated token gate).

6. **Gate handback on skip-context is `now + CHUNK` (≈1 min), not immediate.** Immediate
   release would let a burst of oversized sessions each probe-claim in the same minute;
   1 min preserves the gate's pacing purpose while not starving healthy sessions for an hour.

7. **Duplicated helpers consolidated into `store.js`** (`listJson`, guarded `aliveProcess`).
   The unguarded hook.js copy would have signalled the whole process group on pid 0.

## 2026-08-06 — upstream merge (78a077d)

8. **Hybrid visible-terminal resume adopted as-is** (it independently implements this
   branch's "interactive-resume transport hedge" recommendation), with three integrations:
   token-estimate oversize feeds its deferred-`oversized` flag; the weekly ceiling gates the
   visible path too (see #4); `openSessionTerminal` uses the project-local config overlay.

9. **Dashboard auth is layered, not either/or**: loopback Host allowlist + per-launch token
   on every route (this branch) AND Origin + custom-header + busy-409 checks on POST
   `/api/open` (upstream). The token protects reads on shared machines; the header/Origin
   pair blocks cross-site POSTs even if a token leaks into a referrer. `/api/open` routing
   matches on `url.pathname` so the token query param doesn't break it.
   `server.taskwakeUrl` exposes the tokenized URL for tests/embedders.

10. **Kept my `classifyError`/`saveEvent` over upstream's** (upstream still had the
    `error ?? error_type` precedence bug and `[object Object]` stringification) — the
    documented-schema-defensive version wins; upstream's `ralphFile` cleanup on SessionEnd
    adopted.

11. **Version/branding taken from upstream** (v1.2.2, "TaskWake Contributors").

## Earlier (Phase 1, see docs/blindspot-analysis-2026-07.md addendum)

12. Defensive dual-shape StopFailure parsing instead of trusting either the docs or the old
    code — live capture (the only ground truth) was explicitly deferred by the user.
13. Weekly auto-resume budget ceiling default ON at 50/7d — protective default consistent
    with the project's "bounded everything" invariant.
14. Per-project `.taskwake.json` overlays the global config (Ralph opt-in/out per repo).
