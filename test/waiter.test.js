import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// store.js reads REWAKE_* at import time, so pin the environment before any dynamic import.
const tmp = await mkdtemp(join(tmpdir(), 'rewake-'));
process.env.REWAKE_HOME = join(tmp, 'home');
process.env.REWAKE_CONFIG = join(tmp, 'config.json');

const { saveEvent, reconcile, ralph, trackSession } = await import('../src/hook.js');
const { claimUsageProbe, initialDeadline, recentResumeCount, wait } = await import('../src/waiter.js');
const { home, pendingDir, doneDir, sessionsDir, loadConfig, readJson, writeAtomic } = await import('../src/store.js');
const { defaults } = await import('../src/core.js');
const { buildSnapshot, canOpenSession, startDashboard } = await import('../src/dashboard.js');

const waiterPath = fileURLToPath(new URL('../src/waiter.js', import.meta.url));
const hookPath = fileURLToPath(new URL('../src/hook.js', import.meta.url));
const callsFile = join(tmp, 'shim-calls.txt');
const shimOk = join(tmp, 'shim-ok.mjs');
const shimLimited = join(tmp, 'shim-limited.mjs');
const shimMentionsLimit = join(tmp, 'shim-mentions-limit.mjs');
const shimBricked = join(tmp, 'shim-bricked.mjs');
const shimIdle = join(tmp, 'shim-idle.mjs');
const config = (claudeCmd) => ({
  ...defaults, claudeCmd, resumeMode: 'headless', marginMs: 0, notify: 'none', maxAttempts: 2,
  usagePollMs: 50, usageResumeSpacingMs: 50, overloadMs: [50, 50],
});

before(async () => {
  await writeFile(process.env.REWAKE_CONFIG, JSON.stringify(config([process.execPath, shimOk])));
  await writeFile(shimOk, `
    import { appendFile } from 'node:fs/promises';
    await appendFile(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    process.stdout.write('{"type":"result","is_error":false,"num_turns":3,"total_cost_usd":0.07,"result":"ok"}');
  `);
  await writeFile(shimLimited, `
    process.stdout.write("You've hit your session limit");
    process.exit(1);
  `);
  // A genuinely successful turn whose reply text legitimately discusses rate limits (e.g.
  // dogfooding taskwake, or writing a rate limiter) — must classify as resumed, not still-limited.
  // The reply text deliberately contains "try again in ..." — a phrase failureKind matches.
  // A well-formed non-error JSON result with exit 0 must be trusted without banner-scanning
  // the reply; this exact sample was misclassified before classifyProbe existed.
  await writeFile(shimMentionsLimit, `
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, num_turns: 4,
      result: 'Done. The retry helper now waits and will try again in 5 seconds when the queue is full.',
    }));
  `);
  await writeFile(shimBricked, `
    process.stdout.write('Error: 400 diagnostics.previous_message_id: message not found');
    process.exit(1);
  `);
  await writeFile(shimIdle, `
    process.stdout.write(JSON.stringify({
      type: 'result', is_error: false, num_turns: 1,
      result: "I don't have permission to run that command.",
    }));
  `);
});

after(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('hook saveEvent', () => {
  it('records a pending session once and parses the reset hint', async () => {
    const now = Date.now();
    const record = await saveEvent({
      session_id: 'e2e-1', error: 'rate_limit', cwd: tmp,
      error_details: 'session limit reached · resets in 60 minutes',
    });
    assert.equal(record.kind, 'usage');
    assert.ok(record.resetHint >= now + 59 * 60_000 && record.resetHint <= now + 61 * 60_000);
    assert.equal(await saveEvent({ session_id: 'e2e-1', error: 'rate_limit' }), undefined, 'dedup');
    const legacy = await saveEvent({ session_id: 'legacy', error_type: 'server_error' });
    assert.equal(legacy.kind, 'overload', 'Claude 2.1 compatibility');
    await unlink(join(pendingDir, 'legacy.json'));
    assert.equal(await saveEvent({ session_id: 'x', error: 'authentication_failed' }), undefined, 'unhandled type');
  });
});

describe('hook saveEvent field precedence', () => {
  it('prefers the documented error_type over a human-readable error message, and reads retry_after_seconds', async () => {
    const now = Date.now();
    const record = await saveEvent({
      session_id: 'prec-1', error_type: 'rate_limit',
      error: 'Rate limit exceeded. Please try again in 60 seconds.',
      error_details: { retry_after_seconds: 60 },
    });
    assert.equal(record.kind, 'usage');
    assert.ok(record.resetHint >= now + 59_000 && record.resetHint <= now + 61_000, 'used retry_after_seconds, not text parsing');
    assert.doesNotMatch(record.details, /\[object Object\]/, 'error_details object must not stringify to [object Object]');
    await unlink(join(pendingDir, 'prec-1.json'));
  });

  it('still resolves when a type token arrives in `error` with no `error_type` (older/altered shape)', async () => {
    const record = await saveEvent({ session_id: 'prec-2', error: 'overloaded' });
    assert.equal(record.kind, 'overload');
    await unlink(join(pendingDir, 'prec-2.json'));
  });
});

describe('account-wide usage gate', () => {
  it('allows only one concurrent Claude probe', async () => {
    await unlink(join(home, 'usage-gate.json')).catch(() => {});
    const settings = { ...defaults, usagePollMs: 60_000 };
    const now = Date.now();
    const claims = await Promise.all([
      claimUsageProbe('gate-a', settings, now),
      claimUsageProbe('gate-b', settings, now),
    ]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(claims.filter((claim) => !claim.claimed).length, 1);
    await unlink(join(home, 'usage-gate.json')).catch(() => {});
  });
});
describe('hook subprocess end to end', () => {
  it('takes a BOM-prefixed StopFailure event on stdin all the way to resumed', async () => {
    const event = JSON.stringify({
      session_id: 'full-1', error: 'rate_limit',
      error_details: 'session limit reached; resets in 1 seconds', cwd: tmp,
    });
    const child = spawn(process.execPath, [hookPath], { env: process.env, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end(String.fromCharCode(0xFEFF) + event); // Windows pipes prepend a BOM — the regression that shipped
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0);
    const doneFile = join(doneDir, 'full-1.json');
    let done;
    for (let tick = 0; tick < 100 && !done; tick++) { // detached waiter needs ~1s reset + probe
      await new Promise((resolve) => setTimeout(resolve, 100));
      done = await readJson(doneFile);
    }
    assert.equal(done?.status, 'resumed', 'detached waiter resumed via shim');
  });
});

describe('reconcile after reboot', () => {
  it('respawns only orphaned waiters', async () => {
    const deadPid = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', '']);
      child.once('exit', () => resolve(child.pid));
    });
    const base = { kind: 'usage', errorType: 'rate_limit', details: 'session limit', transcriptBytes: 0 };
    await writeAtomic(join(pendingDir, 'orph.json'), {
      ...base, session: 'orph', resetHint: Date.now() + 100, receivedAt: Date.now() - 300_000, waiterPid: deadPid,
    });
    await writeAtomic(join(pendingDir, 'claimed.json'), {
      ...base, session: 'claimed', resetHint: Date.now() + 100, receivedAt: Date.now() - 300_000, waiterPid: process.pid,
    });
    await writeAtomic(join(pendingDir, 'fresh.json'), {
      ...base, session: 'fresh', resetHint: Date.now() + 100, receivedAt: Date.now(),
    });
    await writeAtomic(join(pendingDir, 'probing.json'), {
      ...base, session: 'probing', resetHint: Date.now(), receivedAt: Date.now() - 300_000,
      waiterPid: deadPid, probePid: process.pid,
    });
    assert.equal(await reconcile(), 1, 'only the orphan respawns');
    let done;
    for (let tick = 0; tick < 100 && !done; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      done = await readJson(join(doneDir, 'orph.json'));
    }
    assert.equal(done?.status, 'resumed');
    assert.equal(await readJson(join(doneDir, 'claimed.json')), undefined, 'claimed session untouched');
    assert.equal(await readJson(join(doneDir, 'fresh.json')), undefined, 'fresh session untouched');
    assert.equal(await readJson(join(doneDir, 'probing.json')), undefined, 'live probe untouched');
    await unlink(join(pendingDir, 'claimed.json')).catch(() => {});
    await unlink(join(pendingDir, 'fresh.json')).catch(() => {});
    await unlink(join(pendingDir, 'probing.json')).catch(() => {});
  });
});

describe('multi-session tracking and dashboard', () => {
  it('opens only sessions that have no live automatic or interactive owner', () => {
    for (const status of ['active', 'running', 'waiting', 'orphaned']) assert.equal(canOpenSession({ status }), false, status);
    for (const status of ['ended', 'resumed', 'gave-up', 'stale']) assert.equal(canOpenSession({ status }), true, status);
  });

  it('rejects cross-site and concurrent terminal takeover requests', async () => {
    await trackSession({ session_id: 'takeover-busy', cwd: tmp }, false, process.pid);
    const server = await startDashboard({ port: 0, open: false });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const token = new URL(server.taskwakeUrl).searchParams.get('token');
    try {
      const noToken = await fetch(`${origin}/api/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TaskWake-Action': 'open-session', Origin: origin },
        body: JSON.stringify({ session: 'takeover-busy' }),
      });
      assert.equal(noToken.status, 403, 'missing token is rejected even with the right headers');
      const forbidden = await fetch(`${origin}/api/open?token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 'takeover-busy' }),
      });
      assert.equal(forbidden.status, 403, 'missing Origin/action header is rejected even with the token');
      const busy = await fetch(`${origin}/api/open?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TaskWake-Action': 'open-session', Origin: origin },
        body: JSON.stringify({ session: 'takeover-busy' }),
      });
      assert.equal(busy.status, 409);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('tracks lifecycle, transcript activity, and same-directory conflicts', async () => {
    const transcriptA = join(tmp, 'tracked-a.jsonl');
    const transcriptB = join(tmp, 'tracked-b.jsonl');
    const row = JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });
    await Promise.all([writeFile(transcriptA, row + '\n'), writeFile(transcriptB, row + '\n')]);
    await trackSession({
      session_id: 'tracked-a', cwd: tmp, transcript_path: transcriptA,
      permission_mode: 'auto', model: 'test-model', source: 'startup',
    }, false, process.pid);
    await trackSession({
      session_id: 'tracked-b', cwd: join(tmp, 'nested'), transcript_path: transcriptB, source: 'startup',
    }, false, process.pid);

    const snapshot = await buildSnapshot();
    const a = snapshot.sessions.find((item) => item.session === 'tracked-a');
    const b = snapshot.sessions.find((item) => item.session === 'tracked-b');
    assert.equal(a.status, 'active');
    assert.equal(a.conflict, true);
    assert.equal(b.conflict, true);
    assert.equal(a.activity[0].label, 'Bash');
    assert.match(a.activity[0].detail, /npm test/);

    await trackSession({ session_id: 'tracked-a', reason: 'other' }, true, process.pid);
    const ended = await readJson(join(sessionsDir, 'tracked-a.json'));
    assert.equal(ended.status, 'ended');
    assert.equal(ended.reason, 'other');
  });

  it('serves cached activity on idle polls but reflects new transcript rows immediately', async () => {
    const transcript = join(tmp, 'cache-check.jsonl');
    const toolRow = (command) => JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
    }) + '\n';
    await writeFile(transcript, toolRow('first command'));
    await trackSession({ session_id: 'cache-check', cwd: join(tmp, 'cache-project'), transcript_path: transcript }, false, process.pid);
    const first = await buildSnapshot();
    const before = first.sessions.find((item) => item.session === 'cache-check');
    assert.match(before.activity[0].detail, /first command/);
    // mtime granularity can be coarse; wait long enough that the append changes it or size
    await new Promise((resolve) => setTimeout(resolve, 20));
    await appendFile(transcript, toolRow('second command'));
    const second = await buildSnapshot();
    const after = second.sessions.find((item) => item.session === 'cache-check');
    assert.match(after.activity[0].detail, /second command/, 'the cache must invalidate when the transcript grows');
  });
});
describe('Ralph loop', () => {
  it('continues every session when enabled and obeys done and turn limits', async () => {
    const settings = { ...defaults, ralph: true, ralphMaxTurns: 2 };
    assert.equal(await ralph({ session_id: 'ralph-off' }, { ...settings, ralph: false }), undefined);
    const first = await ralph({ session_id: 'ralph-on' }, settings);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /1\/2/);
    assert.match(first.reason, /reversible project-local choice/);
    assert.equal(await ralph({ session_id: 'ralph-on' }, settings), undefined, 'max turns stops');
    await ralph({ session_id: 'ralph-ended' }, settings);
    await trackSession({ session_id: 'ralph-ended', reason: 'other' }, true, process.pid);
    assert.equal(await readJson(join(home, 'ralph', 'ralph-ended.json')), undefined, 'session end clears Ralph state');
    assert.equal(await ralph({
      session_id: 'ralph-done', last_assistant_message: 'All safe local work is complete. [RALPH_DONE]',
    }, settings), undefined, 'sentinel stops');
  });
});
describe('waiter end to end', () => {
  it('sleeps until the hint, probes with --resume, records success (subprocess)', async () => {
    const pending = join(pendingDir, 'e2e-1.json');
    await writeAtomic(pending, { ...(await readJson(pending)), resetHint: Date.now() + 150 });
    const code = await new Promise((resolve) => {
      spawn(process.execPath, [waiterPath, 'e2e-1'], { env: process.env, stdio: 'ignore' })
        .once('exit', resolve);
    });
    assert.equal(code, 0);
    const done = await readJson(join(doneDir, 'e2e-1.json'));
    assert.equal(done.status, 'resumed');
    assert.equal(done.numTurns, 3, 'turn count from the CLI result JSON is recorded');
    assert.equal(done.costUsd, 0.07, 'cost from the CLI result JSON is recorded');
    assert.equal(await readJson(pending), undefined, 'pending cleared');
    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => call.includes('--resume') && call.includes('e2e-1')), `shim got ${calls}`);
  });

  it('skips a weekly limit under the default cost policy', async () => {
    await writeAtomic(join(pendingDir, 'wk.json'), {
      session: 'wk', kind: 'usage', errorType: 'rate_limit',
      details: "You've hit your weekly limit · resets Jul 24", resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('wk', config([process.execPath, shimOk]));
    assert.equal(result.status, 'skipped-weekly');
  });

  it('skips an oversized transcript', async () => {
    await writeAtomic(join(pendingDir, 'big.json'), {
      session: 'big', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: defaults.maxContextResume + 1,
    });
    const result = await wait('big', config([process.execPath, shimOk]));
    assert.equal(result.status, 'skipped-context');
  });

  it('gives up after bounded attempts when the probe stays limited', async () => {
    await writeAtomic(join(pendingDir, 'lim.json'), {
      session: 'lim', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('lim', config([process.execPath, shimLimited]));
    assert.equal(result.status, 'gave-up');
    assert.equal(result.attempts, 2);
    assert.match(result.lastError, /session limit/i);
  });

  it('exits quietly when the pending file is cancelled mid-sleep', async () => {
    const pending = join(pendingDir, 'cxl.json');
    await writeAtomic(pending, {
      session: 'cxl', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now() + 1_500, transcriptBytes: 0,
    });
    const running = wait('cxl', { ...config([process.execPath, shimOk]), usagePollMs: 5_000 });
    setTimeout(() => unlink(pending).catch(() => {}), 100);
    assert.equal(await running, undefined);
    assert.equal(await readJson(join(doneDir, 'cxl.json')), undefined, 'no done record');
  });

  it('does not misclassify a genuinely successful reply that discusses rate limits', async () => {
    await writeAtomic(join(pendingDir, 'mention.json'), {
      session: 'mention', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('mention', config([process.execPath, shimMentionsLimit]));
    assert.equal(result.status, 'resumed', 'scanning only the structured result text avoids the false positive');
  });

  it('stops immediately on a previous_message_id corruption signature instead of retrying it', async () => {
    await writeAtomic(join(pendingDir, 'brk.json'), {
      session: 'brk', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('brk', config([process.execPath, shimBricked]));
    assert.equal(result.status, 'bricked');
    assert.equal(result.attempts, 1, 'did not burn further attempts on an unfixable error');
  });

  it('flags a permission-blocked "success" as resumed-idle', async () => {
    await writeAtomic(join(pendingDir, 'idl.json'), {
      session: 'idl', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('idl', config([process.execPath, shimIdle]));
    assert.equal(result.status, 'resumed-idle');
  });

  it('skips on the token estimate even when the raw byte size is under the byte gate', async () => {
    await writeAtomic(join(pendingDir, 'tok.json'), {
      session: 'tok', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 1_000,
    });
    const result = await wait('tok', { ...config([process.execPath, shimOk]), maxContextResumeTokens: 100 });
    assert.equal(result.status, 'skipped-context', '1000 bytes is far under maxContextResume but ~250 estimated tokens exceeds a 100-token ceiling');
  });
});

describe('initial deadline trust', () => {
  it('honours a machine-readable resetHint even when the details text cannot be re-parsed', () => {
    const hint = Date.now() + 60_000;
    const machine = initialDeadline({
      details: '{"retry_after_seconds":60}', resetHint: hint, resetParsed: true, receivedAt: Date.now(),
    }, { ...defaults, marginMs: 0 });
    assert.equal(machine.trusted, true, 'retry_after_seconds-derived hint is trustworthy');
    assert.equal(machine.deadline, hint);
    const fallback = initialDeadline({
      details: 'no parseable time here', resetHint: 0, resetParsed: false, receivedAt: Date.now(),
    }, { ...defaults, marginMs: 0 });
    assert.equal(fallback.trusted, false, 'an unparsed banner with no machine hint stays untrusted');
  });
});

describe('usage gate release on skip', () => {
  it('returns the gate quickly when an oversized session skips after claiming it', async () => {
    await unlink(join(home, 'usage-gate.json')).catch(() => {});
    await writeAtomic(join(pendingDir, 'gate-skip.json'), {
      session: 'gate-skip', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: defaults.maxContextResume + 1,
    });
    const result = await wait('gate-skip', { ...config([process.execPath, shimOk]), usagePollMs: 3_600_000 });
    assert.equal(result.status, 'skipped-context');
    const gate = await readJson(join(home, 'usage-gate.json'));
    assert.ok(gate.nextProbeAt <= Date.now() + 61_000, `gate must be freed within ~1 minute, was reserved until ${new Date(gate.nextProbeAt).toISOString()}`);
    await unlink(join(home, 'usage-gate.json')).catch(() => {});
  });
});

describe('weekly auto-resume budget ceiling', () => {
  it('counts only resumed/resumed-idle records within the trailing window', async () => {
    const before = await recentResumeCount();
    const fresh = ['budget-count-a', 'budget-count-b'];
    for (const session of fresh) {
      await writeAtomic(join(doneDir, `${session}.json`), { session, status: 'resumed', finishedAt: Date.now() - 1_000 });
    }
    await writeAtomic(join(doneDir, 'budget-count-old.json'), {
      session: 'budget-count-old', status: 'resumed', finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000,
    });
    await writeAtomic(join(doneDir, 'budget-count-other.json'), {
      session: 'budget-count-other', status: 'gave-up', finishedAt: Date.now() - 1_000,
    });
    const after = await recentResumeCount();
    assert.equal(after - before, fresh.length, 'only the two fresh resumed records count');
    for (const session of [...fresh, 'budget-count-old', 'budget-count-other']) {
      await unlink(join(doneDir, `${session}.json`)).catch(() => {});
    }
  });

  it('skips auto-resume once the rolling count reaches the configured ceiling', async () => {
    const current = await recentResumeCount();
    await writeAtomic(join(doneDir, 'budget-fill.json'), { session: 'budget-fill', status: 'resumed', finishedAt: Date.now() - 1_000 });
    await writeAtomic(join(pendingDir, 'budget.json'), {
      session: 'budget', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('budget', { ...config([process.execPath, shimOk]), weeklyResumeCeiling: current + 1 });
    assert.equal(result.status, 'skipped-weekly-budget');
    await unlink(join(doneDir, 'budget-fill.json')).catch(() => {});
  });

  it('is disabled by weeklyResumeCeiling: 0', async () => {
    const current = await recentResumeCount();
    await writeAtomic(join(doneDir, 'budget-fill2.json'), { session: 'budget-fill2', status: 'resumed', finishedAt: Date.now() - 1_000 });
    await writeAtomic(join(pendingDir, 'budget-off.json'), {
      session: 'budget-off', kind: 'usage', errorType: 'rate_limit',
      details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
    });
    const result = await wait('budget-off', { ...config([process.execPath, shimOk]), weeklyResumeCeiling: 0, usageResumeSpacingMs: 50 });
    assert.notEqual(result.status, 'skipped-weekly-budget');
    assert.ok(current >= 0);
    await unlink(join(doneDir, 'budget-fill2.json')).catch(() => {});
  });
});

describe('workspace fingerprint hold', () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (repo, ...args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repo, env: gitEnv, stdio: 'ignore' });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`)));
  });
  const pendingRecord = (session, repo, workspace) => ({
    session, kind: 'usage', errorType: 'rate_limit', cwd: repo, workspace,
    details: 'session limit', resetHint: Date.now(), transcriptBytes: 0,
  });

  it('holds when the repo changed while waiting, resumes when unchanged or policy is ignore', async () => {
    const { workspaceFingerprint } = await import('../src/store.js');
    const repo = join(tmp, 'ws-repo');
    await writeFile(join(tmp, '.keep'), '');
    await git(tmp, 'init', '-q', 'ws-repo');
    await writeFile(join(repo, 'file.txt'), 'v1\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'v1');
    const fingerprint = await workspaceFingerprint(repo);
    assert.ok(fingerprint, 'a committed repo fingerprints');

    await writeAtomic(join(pendingDir, 'ws-same.json'), pendingRecord('ws-same', repo, fingerprint));
    const unchanged = await wait('ws-same', config([process.execPath, shimOk]));
    assert.equal(unchanged.status, 'resumed', 'an unchanged workspace resumes normally');

    await writeFile(join(repo, 'file.txt'), 'v2 dirty\n');
    await writeAtomic(join(pendingDir, 'ws-changed.json'), pendingRecord('ws-changed', repo, fingerprint));
    const held = await wait('ws-changed', config([process.execPath, shimOk]));
    assert.equal(held.status, 'skipped-workspace-changed', 'a dirtied workspace holds the resume');

    await writeAtomic(join(pendingDir, 'ws-ignored.json'), pendingRecord('ws-ignored', repo, fingerprint));
    const ignored = await wait('ws-ignored', { ...config([process.execPath, shimOk]), workspacePolicy: 'ignore' });
    assert.equal(ignored.status, 'resumed', 'policy ignore opts out of the hold');
  });

  it('never holds a session that could not be fingerprinted at interruption', async () => {
    await writeAtomic(join(pendingDir, 'ws-none.json'), pendingRecord('ws-none', tmp, undefined));
    const result = await wait('ws-none', config([process.execPath, shimOk]));
    assert.equal(result.status, 'resumed');
  });
});

describe('done record pruning', () => {
  it('reconcile removes done records older than 30 days and keeps fresh ones', async () => {
    await writeAtomic(join(doneDir, 'prune-old.json'), {
      session: 'prune-old', status: 'resumed', finishedAt: Date.now() - 31 * 24 * 60 * 60 * 1_000,
    });
    await writeAtomic(join(doneDir, 'prune-new.json'), {
      session: 'prune-new', status: 'resumed', finishedAt: Date.now() - 1_000,
    });
    await reconcile();
    assert.equal(await readJson(join(doneDir, 'prune-old.json')), undefined, 'stale record pruned');
    assert.ok(await readJson(join(doneDir, 'prune-new.json')), 'fresh record kept');
    await unlink(join(doneDir, 'prune-new.json')).catch(() => {});
  });
});

describe('per-project config overlay', () => {
  it('layers a project-local .taskwake.json over the global config, without mutating the global default', async () => {
    const project = await mkdtemp(join(tmpdir(), 'taskwake-project-'));
    await writeFile(join(project, '.taskwake.json'), JSON.stringify({ ralph: true, ralphMaxTurns: 3 }));
    const projectConfig = await loadConfig(project);
    assert.equal(projectConfig.ralph, true);
    assert.equal(projectConfig.ralphMaxTurns, 3);
    const globalConfig = await loadConfig();
    assert.equal(globalConfig.ralph, false, 'the project override must not leak into the global-only load');
    await rm(project, { recursive: true, force: true });
  });

  it('lets a project opt out of ralph via its own .taskwake.json even with a Stop-hook call', async () => {
    const project = await mkdtemp(join(tmpdir(), 'taskwake-project-'));
    await writeFile(join(project, '.taskwake.json'), JSON.stringify({ ralph: false }));
    // simulate a global config with ralph on by writing it, then confirm the project overlay wins
    const globalRaw = JSON.parse(await readFile(process.env.REWAKE_CONFIG, 'utf8'));
    await writeFile(process.env.REWAKE_CONFIG, JSON.stringify({ ...globalRaw, ralph: true }));
    try {
      assert.equal(await ralph({ session_id: 'proj-off', cwd: project }, undefined), undefined, 'project override disables ralph despite global ralph:true');
    } finally {
      await writeFile(process.env.REWAKE_CONFIG, JSON.stringify(globalRaw));
      await rm(project, { recursive: true, force: true });
    }
  });
});
