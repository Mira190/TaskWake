import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  codexExecIndex, codexResumeArgs, failureKind, isWeekly,
  jsonCodexArgs, readCodexJson, resetEpoch,
} from '../src/core.js';
import { dashboardPage } from '../src/dashboard-page.js';
import { isChineseLocale } from '../src/i18n.js';
import { canShowTerminal, resumeArgv } from '../src/store.js';
import { evaluateProbe, originalStillRunning, shouldOpenTerminal } from '../src/waiter.js';

describe('visible resume policy', () => {
  it('opens only after the deadline on an interactive desktop', async () => {
    assert.equal(await shouldOpenTerminal('usage', 'hybrid', 10, 9, { SESSIONNAME: 'Console' }, 'win32'), false);
    assert.equal(await shouldOpenTerminal('usage', 'hybrid', 10, 10, { SESSIONNAME: 'Console' }, 'win32'), true);
    assert.equal(await shouldOpenTerminal('usage', 'headless', 10, 10, { SESSIONNAME: 'Console' }, 'win32'), false);
  });

  it('detects interactive desktops without treating services as visible', async () => {
    assert.equal(await canShowTerminal({ SESSIONNAME: 'Console' }, 'win32'), true);
    assert.equal(await canShowTerminal({ SESSIONNAME: 'Services' }, 'win32'), false);
    assert.equal(await canShowTerminal({}, 'win32', async () => ({ code: 0 })), true);
    assert.equal(await canShowTerminal({}, 'win32', async () => ({ code: 1 })), false);
    assert.equal(await canShowTerminal({}, 'win32', async () => { throw new Error('blocked'); }), false);
    assert.equal(await canShowTerminal({ DISPLAY: ':0' }, 'linux'), true);
    assert.equal(await canShowTerminal({}, 'linux'), false);
  });
});

describe('headless probe evaluation', () => {
  it('trusts the JSON result envelope over banner regexes', () => {
    const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the rate limit reset bug; try again in 5 minutes.' });
    assert.deepEqual(evaluateProbe({ code: 0, stdout: success, stderr: '' }), { ok: true, kind: undefined, text: '' });
    const limited = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 3pm" });
    const failed = evaluateProbe({ code: 1, stdout: limited, stderr: '' });
    assert.equal(failed.ok, false);
    assert.equal(failed.kind, 'usage');
    assert.match(failed.text, /session limit/);
  });

  it('reads the last result line of JSONL and falls back to plain text', () => {
    const jsonl = [JSON.stringify({ type: 'system' }), JSON.stringify({ type: 'result', is_error: false, result: 'usage limit' })].join('\n');
    assert.equal(evaluateProbe({ code: 0, stdout: jsonl, stderr: '' }).ok, true);
    assert.deepEqual(
      { ...evaluateProbe({ code: 1, stdout: "You've hit your session limit", stderr: '' }), text: undefined },
      { ok: false, kind: 'usage', text: undefined },
    );
    assert.equal(evaluateProbe({ code: 0, stdout: 'done', stderr: '' }).ok, true);
    assert.equal(evaluateProbe({ code: 2, stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution' }), stderr: '' }).kind, undefined);
  });
});

describe('permission mode inheritance', () => {
  it('resumes with the registered mode unless disabled or already configured', () => {
    const config = { claudeCmd: ['claude'], inheritPermissionMode: true };
    assert.deepEqual(resumeArgv(config, 's1', { permissionMode: 'acceptEdits' }), ['claude', '--resume', 's1', '--permission-mode', 'acceptEdits']);
    assert.deepEqual(resumeArgv(config, 's1', { permissionMode: 'bypassPermissions' }).slice(-1), ['bypassPermissions']);
    assert.deepEqual(resumeArgv(config, 's1', { permissionMode: 'default' }), ['claude', '--resume', 's1']);
    assert.deepEqual(resumeArgv(config, 's1', { permissionMode: 'weird; rm -rf' }), ['claude', '--resume', 's1']);
    assert.deepEqual(resumeArgv(config, 's1', undefined), ['claude', '--resume', 's1']);
    assert.deepEqual(resumeArgv({ ...config, inheritPermissionMode: false }, 's1', { permissionMode: 'auto' }), ['claude', '--resume', 's1']);
    assert.deepEqual(
      resumeArgv({ ...config, claudeCmd: ['claude', '--permission-mode', 'plan'] }, 's1', { permissionMode: 'auto' }),
      ['claude', '--permission-mode', 'plan', '--resume', 's1'],
    );
  });
});

describe('original terminal warning', () => {
  it('warns only for an active registry entry whose Claude is alive', () => {
    const alive = (pid) => pid === 42;
    assert.equal(originalStillRunning({ status: 'active', claudePid: 42 }, alive), true);
    assert.equal(originalStillRunning({ status: 'active', claudePid: 7 }, alive), false);
    assert.equal(originalStillRunning({ status: 'ended', claudePid: 42 }, alive), false);
    assert.equal(originalStillRunning({ status: 'active' }, alive), false);
    assert.equal(originalStillRunning(undefined, alive), false);
    assert.equal(originalStillRunning({ status: 'active', claudePid: process.pid }), true);
  });
});

describe('locale detection', () => {
  it('uses Chinese only for zh system locales', () => {
    assert.equal(isChineseLocale('zh-CN'), true);
    assert.equal(isChineseLocale('zh_TW'), true);
    assert.equal(isChineseLocale('en-US'), false);
    assert.equal(isChineseLocale('ja-JP'), false);
  });
});
describe('dashboard localization', () => {
  it('ships English and Chinese copy with automatic browser locale detection', () => {
    assert.match(dashboardPage, /navigator\.language/);
    assert.match(dashboardPage, /TaskWake Control Room/);
    assert.match(dashboardPage, /TaskWake 控制中心/);
  });
});
describe('failure classification', () => {
  it('separates usage from overload and ignores normal output', () => {
    assert.equal(failureKind("You've hit your 5-hour limit; resets 4pm"), 'usage');
    assert.equal(failureKind('API Error 529: service overloaded'), 'overload');
    assert.equal(failureKind('API Error: 429 rate limited'), 'overload');
    assert.equal(failureKind('normal assistant output'), undefined);
  });

  it('classifies the whole real-banner corpus', async () => {
    const corpus = JSON.parse(await readFile(new URL('./fixtures/banners.json', import.meta.url), 'utf8'));
    const now = Date.parse('2030-01-15T00:00:00Z');
    for (const { text, kind, weekly, parses } of corpus) {
      assert.equal(failureKind(text), kind ?? undefined, text);
      assert.equal(isWeekly(text), Boolean(weekly), text);
      if (parses) {
        // sentinel fallback: a parse failure returns exactly now + 999
        assert.notEqual(resetEpoch(text, now, 999), now + 999, `should parse: ${text}`);
      }
    }
  });
});

describe('reset scheduling', () => {
  it('parses relative provider waits, including the "resets in:" form', () => {
    assert.equal(resetEpoch('try again in 2 hours', 1_000), 7_201_000);
    assert.equal(resetEpoch('wait 30 minutes', 1_000), 1_801_000);
    assert.equal(resetEpoch('usage limit · resets in: 3 hours', 1_000), 10_801_000);
  });

  it('parses the pipe-epoch and compact relative forms', () => {
    assert.equal(resetEpoch('Claude AI usage limit reached|1893456000', 0), 1_893_456_000_000);
    assert.equal(resetEpoch('Claude AI usage limit reached|1893456000123', 0), 1_893_456_000_123);
    assert.equal(resetEpoch('Claude AI usage limit reached|1893456000', 1_900_000_000_000), 1_900_000_000_000, 'never in the past');
    assert.equal(resetEpoch('resets in 2h 30m', 1_000), 1_000 + 9_000_000);
    assert.equal(resetEpoch('resets 2h30m', 1_000), 1_000 + 9_000_000);
    assert.equal(resetEpoch('try again in 1 hr 5 min', 1_000), 1_000 + 3_900_000);
    assert.equal(resetEpoch('usage limit · resets in 45m', 1_000), 1_000 + 2_700_000);
    assert.equal(resetEpoch('wait 90 mins', 1_000), 1_000 + 5_400_000);
    assert.ok(Number.isNaN(resetEpoch('resets in 5 months', 1_000, Number.NaN)), 'no unit prefix match');
  });

  it('parses the dated form', () => {
    const result = resetEpoch('try again at Jul 5th, 2030 4:09 PM UTC', 0);
    assert.equal(result, Date.parse('Jul 5, 2030 4:09 PM UTC'));
  });

  it('parses IANA-zone clock times from real banners', () => {
    const now = Date.parse('2030-01-15T00:00:00Z'); // London on GMT, offset 0
    assert.equal(
      resetEpoch("You've hit your session limit · resets 6:50pm (Europe/London)", now),
      Date.parse('2030-01-15T18:50:00Z'),
    );
  });

  it('rolls a yearless reset forward only when it lands within 8 days, and resolves ambiguous clock times', () => {
    const now = Date.parse('2030-10-10T00:00:00Z');
    assert.ok(Number.isNaN(resetEpoch('weekly limit; resets Oct 9, 10am UTC', now, Number.NaN)), 'stale date is untrusted');
    assert.equal(resetEpoch('weekly limit; resets Oct 9, 10am UTC', now, 500), now + 500);
    assert.equal(
      resetEpoch('weekly limit; resets Jan 2, 10am UTC', Date.parse('2030-12-30T00:00:00Z'), Number.NaN),
      Date.parse('2031-01-02T10:00:00Z'),
    );
    assert.equal(resetEpoch('resets Oct 9, 2031 10am UTC', now, Number.NaN), Date.parse('2031-10-09T10:00:00Z'), 'explicit year kept');
    assert.equal(
      resetEpoch('usage limit resets 5 (UTC)', Date.parse('2030-01-01T04:00:00Z')),
      Date.parse('2030-01-01T05:00:00Z'),
    );
  });

  it('falls back when nothing parses', () => {
    assert.equal(resetEpoch('some random text', 1_000, 500), 1_500);
  });
});

describe('Codex continuation', () => {
  it('finds exec behind global options and requests JSONL once', () => {
    const args = ['--model', 'gpt-5', 'exec', 'fix it'];
    assert.equal(codexExecIndex(args), 2);
    assert.deepEqual(jsonCodexArgs(args), ['--model', 'gpt-5', 'exec', '--json', 'fix it']);
    assert.deepEqual(jsonCodexArgs(['exec', '--json', 'x']), ['exec', '--json', 'x']);
  });

  it('extracts a thread and resumes that exact thread', () => {
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    ].join('\n');
    assert.deepEqual(readCodexJson(jsonl), { thread: 'abc', message: 'done' });
    assert.deepEqual(
      codexResumeArgs(['--model', 'gpt-5', 'exec', '--sandbox', 'workspace-write', 'old'], 'abc', 'go'),
      ['--model', 'gpt-5', 'exec', 'resume', '--json', '--sandbox', 'workspace-write', 'abc', 'go'],
    );
  });
});
