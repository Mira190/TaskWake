# Technical Debt Register

Ranked by (user impact × likelihood) ÷ fix cost. "Debt" here = things a maintainer will
trip over, not missing features (those are NEXT_STEPS.md).

| # | Debt | Impact | Fix cost | Notes |
|---|---|---|---|---|
| 1 | **No captured-payload fixtures** — every StopFailure/CLI-output fixture is authored from docs, so tests can't catch upstream contract drift. | High | Medium (needs live account) | The capture shim design is in `docs/blindspot-analysis-2026-07.md` Phase 0. Until then `classifyError`/`classifyProbe` stay dual-shape-defensive; don't "simplify" them. |
| 2 | **`wait()` is a 120-line state machine with 8 exit statuses** and interleaved gate/deadline/oversize/terminal concerns. Correct today (10 e2e tests) but the next feature will hurt. | Medium | Medium | If touching it again, extract pure decision functions (`nextAction(state, config, now) → {action, until}`) into core.js and keep I/O in the shell. Do NOT do this speculatively. |
| 3 | **`dashboard-page.js` is a 300-line template-string SPA.** `npm run lint` now parses the embedded `<script>` via `vm.Script` (catches the merge-seam class); remaining debt is that it's still one big string with no runtime testing of the page logic. | Low-medium (was Medium) | Low-medium | Extract page JS to its own file only if it grows further. |
| 4 | **Windows quoting strips embedded quotes and can `%VAR%`-expand `retryText`** (`shellSpawn`, `openTerminal` cmd path). Config-owner input only, so not a security hole, but it corrupts prompts silently. | Medium on Windows | Medium (needs a Windows host to verify) | Documented in KNOWN_FAILURES #8. |
| 5 | ~~Status vocabulary stringly-typed across four files~~ **Resolved 2026-08-14**: `STATUSES` table in core.js drives CLI labels, dashboard priorities, and the embedded page dictionaries (interpolated at module load). | — | — | |
| 6 | ~~No lint script~~ **Resolved 2026-08-14**: `npm run lint` (`scripts/lint.mjs`) — `node --check` over all JS + `vm.Script` parse of the embedded dashboard script. Style consistency still discipline-only (no formatter). | Low | — | |
| 7 | ~~No done/ pruning~~ **Resolved 2026-08-14**: `reconcile` prunes done-records older than 30 days. | — | — | |
| 8 | **Legacy `rewake` compatibility shims** (env vars, home/log/config fallbacks, `bin/rewake.js`) — carried since the rebrand; every config reader pays the dual-path tax. | Low | Low, but a breaking change | Schedule removal for a major version; until then don't add new legacy fallbacks. |
| 9 | **Test suite is one 500-line waiter.test.js** mixing hook, gate, dashboard, ralph, and waiter concerns with shared mutable `tmp` state; several tests must clean up done-records so `recentResumeCount` assertions stay delta-based. | Low | Low | Split by subject when it next grows; keep the delta-based counting pattern. |
| 10 | **Bench corpus `structured` samples are doc-derived** (see debt #1) and the strategy comparison has only 5 samples — enough to catch the class of bug it caught, too few to quote as an accuracy percentage. | Low | Low | Grow it opportunistically from real captures. |
