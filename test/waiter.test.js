import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
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
const { home, pendingDir, doneDir, sessionsDir, readJson, writeAtomic } = await import('../src/store.js');
const { defaults } = await import('../src/core.js');
const { buildSnapshot } = await import('../src/dashboard.js');

const waiterPath = fileURLToPath(new URL('../src/waiter.js', import.meta.url));
const hookPath = fileURLToPath(new URL('../src/hook.js', import.meta.url));
const callsFile = join(tmp, 'shim-calls.txt');
const shimOk = join(tmp, 'shim-ok.mjs');
const shimLimited = join(tmp, 'shim-limited.mjs');
const config = (claudeCmd) => ({
  ...defaults, claudeCmd, marginMs: 0, notify: 'none', maxAttempts: 2,
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
describe('Ralph loop', () => {
  it('continues every session when enabled and obeys done and turn limits', async () => {
    const settings = { ...defaults, ralph: true, ralphMaxTurns: 2 };
    assert.equal(await ralph({ session_id: 'ralph-off' }, { ...settings, ralph: false }), undefined);
    const first = await ralph({ session_id: 'ralph-on' }, settings);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /1\/2/);
    assert.match(first.reason, /reversible project-local choice/);
    assert.equal(await ralph({ session_id: 'ralph-on' }, settings), undefined, 'max turns stops');
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
