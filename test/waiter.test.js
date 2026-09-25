import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// store.js reads REWAKE_* at import time, so pin the environment before any dynamic import.
const tmp = await mkdtemp(join(tmpdir(), 'rewake-'));
process.env.REWAKE_HOME = join(tmp, 'home');
process.env.REWAKE_CONFIG = join(tmp, 'config.json');

const { saveEvent, reconcile, ralph, trackSession } = await import('../src/hook.js');
const { claimUsageProbe, wait } = await import('../src/waiter.js');
const { home, pendingDir, doneDir, sessionsDir, pruneDone, readJson, writeAtomic } = await import('../src/store.js');
const { defaults } = await import('../src/core.js');
const { buildSnapshot, canOpenSession, startDashboard } = await import('../src/dashboard.js');

const waiterPath = fileURLToPath(new URL('../src/waiter.js', import.meta.url));
const hookPath = fileURLToPath(new URL('../src/hook.js', import.meta.url));
const callsFile = join(tmp, 'shim-calls.txt');
const shimOk = join(tmp, 'shim-ok.mjs');
const shimLimited = join(tmp, 'shim-limited.mjs');
const shimTimed = join(tmp, 'shim-timed.mjs'); // argv: <log file> <ok|limited> …claude args
const config = (claudeCmd) => ({
  ...defaults, claudeCmd, resumeMode: 'headless', marginMs: 0, notify: 'none', maxAttempts: 2,
  usagePollMs: 50, usageResumeSpacingMs: 50, overloadMs: [50, 50],
});

before(async () => {
  await writeFile(process.env.REWAKE_CONFIG, JSON.stringify(config([process.execPath, shimOk])));
  await writeFile(shimOk, `
    import { appendFile } from 'node:fs/promises';
    await appendFile(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    process.stdout.write('{"type":"result","result":"ok"}');
  `);
  await writeFile(shimLimited, `
    process.stdout.write("You've hit your session limit");
    process.exit(1);
  `);
  await writeFile(shimTimed, `
    import { appendFile } from 'node:fs/promises';
    const [log, mode] = process.argv.slice(2);
    await appendFile(log, Date.now() + '\\n');
    if (mode === 'limited') { process.stdout.write("You've hit your session limit"); process.exit(1); }
    if (mode === 'overloaded') { process.stderr.write('API Error 529: service overloaded'); process.exit(1); }
    process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"ok"}');
  `);
});

const timed = (name, mode = 'ok') => [process.execPath, shimTimed, join(tmp, `calls-${name}.txt`), mode];
const stamps = async (name) => (await readFile(join(tmp, `calls-${name}.txt`), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(Number);
const usageRecord = (session, extra = {}) => ({
  session, kind: 'usage', errorType: 'rate_limit', details: 'session limit',
  transcriptBytes: 0, receivedAt: Date.now(), ...extra,
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

describe('hook re-arm', () => {
  it('re-arms a pending record whose waiter died when the same session fails again', async () => {
    const deadPid = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', '']);
      child.once('exit', () => resolve(child.pid));
    });
    await writeAtomic(join(pendingDir, 'rearm-1.json'), {
      session: 'rearm-1', kind: 'usage', errorType: 'rate_limit', details: 'session limit', transcriptBytes: 0,
      resetHint: Date.now(), receivedAt: Date.now() - 300_000, waiterPid: deadPid,
    });
    assert.equal(await saveEvent({ session_id: 'rearm-1', error: 'rate_limit' }), undefined, 'no new record');
    let done;
    for (let tick = 0; tick < 100 && !done; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      done = await readJson(join(doneDir, 'rearm-1.json'));
    }
    assert.equal(done?.status, 'resumed');
  });

  it('writes atomically even when one process overlaps writes to the same file', async () => {
    const target = join(tmp, 'overlap.json');
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeAtomic(target, { index })));
    assert.equal(typeof (await readJson(target)).index, 'number');
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
    try {
      const forbidden = await fetch(`${origin}/api/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 'takeover-busy' }),
      });
      assert.equal(forbidden.status, 403);
      const busy = await fetch(`${origin}/api/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TaskWake-Action': 'open-session', Origin: origin },
        body: JSON.stringify({ session: 'takeover-busy' }),
      });
      assert.equal(busy.status, 409);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('rejects requests whose Host header is not the loopback dashboard', async () => {
    const server = await startDashboard({ port: 0, open: false });
    const { port } = server.address();
    const get = (host) => new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api', headers: { Host: host } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).once('error', reject).end();
    });
    try {
      assert.equal(await get(`evil.example:${port}`), 403);
      assert.equal(await get(`127.0.0.1:${port}`), 200);
      assert.equal(await get(`localhost:${port}`), 200);
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
});
describe('done housekeeping', () => {
  it('keeps the newest 100 outcomes and drops ones older than 30 days', async () => {
    const dir = join(tmp, 'prune');
    const now = Date.now();
    const day = 86_400_000;
    await Promise.all(Array.from({ length: 105 }, (_, index) => writeAtomic(join(dir, `r${index}.json`), { finishedAt: now - index * 1_000 })));
    await writeAtomic(join(dir, 'old.json'), { finishedAt: now - 31 * day });
    assert.equal(await pruneDone(dir, now), 6);
    for (const name of ['r0', 'r99']) assert.ok(await readJson(join(dir, `${name}.json`)), name);
    for (const name of ['r100', 'r104', 'old']) assert.equal(await readJson(join(dir, `${name}.json`)), undefined, name);
    await writeAtomic(join(dir, 'r0.json'), { finishedAt: now - 40 * day });
    assert.equal(await pruneDone(dir, now), 1, 'age limit applies inside the newest 100 too');
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

  it('clamps ralphMaxTurns to the 8 consecutive continuations Claude Code allows', async () => {
    const settings = { ...defaults, ralph: true, ralphMaxTurns: 20 };
    for (let turn = 1; turn < 8; turn++) {
      const output = await ralph({ session_id: 'ralph-cap' }, settings);
      assert.equal(output?.decision, 'block', `turn ${turn}`);
      assert.match(output.reason, new RegExp(`${turn}/8`));
    }
    assert.equal(await ralph({ session_id: 'ralph-cap' }, settings), undefined, 'eighth turn stops');
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
});

describe('waiter permission mode', () => {
  it('passes the registered permission mode to the headless probe', async () => {
    await trackSession({ session_id: 'perm-1', cwd: tmp, permission_mode: 'acceptEdits' }, true, process.pid);
    await writeAtomic(join(pendingDir, 'perm-1.json'), usageRecord('perm-1', { resetHint: Date.now() }));
    assert.equal((await wait('perm-1', config([process.execPath, shimOk]))).status, 'resumed');
    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const call = calls.find((item) => item.includes('perm-1'));
    assert.deepEqual(call.slice(call.indexOf('--resume'), call.indexOf('-p')), ['--resume', 'perm-1', '--permission-mode', 'acceptEdits']);
  });
});

describe('waiter deadline state machine', () => {
  it('never probes before a trusted deadline', async () => {
    const now = Date.now();
    await writeAtomic(join(pendingDir, 'dl-trusted.json'), usageRecord('dl-trusted', {
      receivedAt: now, resetParsed: true, resetHint: now + 400,
    }));
    const result = await wait('dl-trusted', { ...config(timed('trusted')), usagePollMs: 50 });
    assert.equal(result.status, 'resumed');
    const calls = await stamps('trusted');
    assert.equal(calls.length, 1, 'no speculative probes');
    assert.ok(calls[0] >= now + 400, `first probe ${calls[0] - now} ms after failure`);
  });

  it('counts only failures at or after an untrusted deadline', async () => {
    await writeAtomic(join(pendingDir, 'dl-untrusted.json'), usageRecord('dl-untrusted', {
      resetParsed: false, resetHint: 0,
    }));
    const started = Date.now();
    const result = await wait('dl-untrusted', {
      ...config(timed('untrusted', 'limited')), fallbackMs: 300, usagePollMs: 50, maxAttempts: 1,
    });
    assert.equal(result.status, 'gave-up');
    assert.equal(result.attempts, 1);
    assert.ok(result.probes > 1, `probes=${result.probes}`);
    assert.ok(result.finishedAt >= started + 300, 'gave up only after the deadline');
    assert.equal((await stamps('untrusted')).length, result.probes, 'every probe reached the shim');
  });

  it('skips an oversized overload headlessly without a usage wait', async () => {
    await writeAtomic(join(pendingDir, 'dl-ovbig.json'), usageRecord('dl-ovbig', {
      kind: 'overload', errorType: 'overloaded', transcriptBytes: defaults.maxContextResume + 1,
    }));
    const started = Date.now();
    const result = await wait('dl-ovbig', { ...config(timed('ovbig')), fallbackMs: 60_000 });
    assert.equal(result.status, 'skipped-context');
    assert.ok(Date.now() - started < 2_000);
  });

  it('resumes an overload after the first backoff', async () => {
    await writeAtomic(join(pendingDir, 'dl-over.json'), usageRecord('dl-over', {
      kind: 'overload', errorType: 'overloaded', details: 'API Error 529',
    }));
    const started = Date.now();
    const result = await wait('dl-over', { ...config(timed('over')), overloadMs: [800, 800] });
    assert.equal(result.status, 'resumed');
    assert.ok(Date.now() - started < 1_600, `took ${Date.now() - started} ms (limit overloadMs[0] * 2)`);
  });

  it('gives up an overload after overloadMaxAttempts, independent of maxAttempts', async () => {
    await writeAtomic(join(pendingDir, 'dl-overmax.json'), usageRecord('dl-overmax', {
      kind: 'overload', errorType: 'overloaded', details: 'API Error 529',
    }));
    const result = await wait('dl-overmax', { ...config(timed('overmax', 'overloaded')), maxAttempts: 2, overloadMaxAttempts: 3 });
    assert.equal(result.status, 'gave-up');
    assert.equal(result.attempts, 3);
    assert.equal((await stamps('overmax')).length, 3);
  });

  it('ignores a parsed reset more than 8 days away', async () => {
    const now = Date.now();
    await writeAtomic(join(pendingDir, 'dl-far.json'), usageRecord('dl-far', {
      receivedAt: now, resetParsed: true, resetHint: now + 30 * 24 * 3_600_000,
    }));
    const result = await wait('dl-far', { ...config(timed('far')), fallbackMs: 100 });
    assert.equal(result.status, 'resumed');
    assert.ok(Date.now() - now < 1_000);
  });
});
