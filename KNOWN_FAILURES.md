# Known Failures, Negative Results, and Unverifiable Claims

The honest ledger. If something here gets fixed or verified, move the entry (with evidence)
to DECISIONS.md or delete it.

## Falsified / self-corrected during this work

1. **"The Phase-1 structured-scan change eliminated the rate-limit-discussion false
   positive" — false.** The benchmark caught the structured strategy failing the exact case
   the change targeted (successful reply containing "try again in 5 seconds"), because the
   reply text was still being banner-scanned; the earlier unit test passed only because its
   sample text avoided the trigger phrase. Fixed via `classifyProbe` short-circuit; the
   treacherous test text was restored to include the trigger phrase.
2. **"`npm test` failure is a sandbox quirk" — false.** Reproduced in a minimal fresh
   project on Node v22.22.2: `node --test <directory>` treats the directory as a literal
   test-file entry. Real breakage for any user on this Node line; fixed in package.json.

## Negative / not-worth-it results (deliberate non-optimizations)

3. **`resetEpoch` throughput (~4 k ops/s, Intl.DateTimeFormat-dominated).** It runs a
   handful of times per limit event. Optimizing it (caching formatters, hand-rolled tz
   math) would add risk to the most subtle code in the repo for zero user-visible gain.
   Proof it's not worthwhile: at 4 k ops/s, a year of hourly limit events costs < 3 ms total.
4. **Snapshot caching at typical scale (N=3 sessions): 11.6 ms → 1.0 ms.** Both
   imperceptible; the optimization is justified only by the 30-session case and by I/O
   hygiene. Recorded so nobody later cites the small-N number as a win.
5. **Cold snapshot latency: unchanged (~103 ms at 30×200 KB), as predicted** — a cache
   cannot help a first view. The improved run's cold *mean* (11 ms) is an artifact of 24/25
   reps hitting the cache; use the max. Documented so the flattering number doesn't get
   quoted.

## Known failure modes (open, by design or by deferral)

6. **Trigger contract unverified (existential).** No captured real-world StopFailure payload
   for a subscription seat limit; docs suggest seat limits may be UI-state, not API errors
   (blindspot doc §2.1). If they fire no hook, TaskWake's headline path never triggers and
   nothing in CI would notice. Also unverified live: whether `--resume -p` preserves the
   session id in practice (upstream issue #10806 says sometimes not) and whether the hybrid
   terminal's auto-submitted prompt behaves as coded on each OS. Needs a live account +
   desktop (NEXT_STEPS #1); cannot be closed from this environment.
7. **English-only banner parsing.** A localized or reworded CLI banner silently degrades to
   the 5-hour fallback + probe-verify. Mitigation: fallback is bounded and self-correcting;
   corpus + parse-recall metric exist to absorb new banners as they're observed.
8. **Windows paths are logic-tested but not OS-verified in this environment** (cmd.exe
   quoting strips embedded quotes and can expand `%VAR%` in `retryText`; PowerShell toast;
   Task Scheduler install; `canShowTerminal` session probe). Treat as untested on real
   Windows until someone runs the suite there.
9. **PID-reuse false-skip in `reconcile`** — a recycled OS pid can make an orphaned waiter
   look alive for one reconcile cycle. Accepted: self-heals on the next SessionStart; a
   start-time check would add platform-specific code for a rare, transient miss.
10. **Same-size in-place transcript rewrites would serve stale dashboard activity** (cache
    keys on mtime+size; JSONL is append-only in practice). Accepted with a regression test
    covering the append path; revisit only if transcripts ever stop being append-only.
11. **The account probe gate is per-machine.** Two machines on one account will not
    coordinate probes; worst case both probe within the same hour. Multi-machine
    coordination was evaluated and deferred (blindspot doc §7 / NEXT_STEPS).
12. **`fetch`-based dashboard tests depend on Node's global fetch** honoring explicit
    `Origin`/`Host` headers; if a future Node restricts forbidden headers in `fetch`, the
    auth tests (not the auth itself) would need a raw-socket rewrite.

## Inconclusive

13. **Hybrid visible-open on a desktopless CI**: `canShowTerminal` correctly returns false
    under Linux-without-DISPLAY (unit-tested), but the full `opened` happy path (terminal
    actually appearing, pid captured) has never executed anywhere reachable by this repo's
    tests. The `finish('opened')` branch is live-unverified code.
