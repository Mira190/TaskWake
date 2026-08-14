import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  classifyProbe, codexExecIndex, codexResumeArgs, codexStreamScanner, estimateTokens,
  failureKind, isWeekly, jsonCodexArgs, looksBricked, looksIdle, parseCliJsonResult,
  readCodexJson, resetEpoch, STATUSES, statusLabel, statusPriority,
} from '../src/core.js';
import { dashboardPage } from '../src/dashboard-page.js';
import { isChineseLocale } from '../src/i18n.js';
import { canShowTerminal } from '../src/store.js';
import { shouldOpenTerminal } from '../src/waiter.js';

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

  it('embeds the status labels generated from the shared STATUSES table', () => {
    assert.match(dashboardPage, /Opened in terminal/, 'en labels interpolated');
    assert.match(dashboardPage, /已在终端打开/, 'zh labels interpolated');
    assert.match(dashboardPage, /skipped-workspace-changed/, 'new statuses flow through without page edits');
  });
});

describe('status table', () => {
  it('labels and priorities come from one table, with safe fallbacks', () => {
    assert.equal(statusLabel('resumed'), 'Resumed');
    assert.equal(statusLabel('resumed', true), '已续跑');
    assert.equal(statusLabel('some-unknown-status'), 'some-unknown-status');
    assert.ok(statusPriority('running') < statusPriority('waiting'));
    assert.ok(statusPriority('waiting') < statusPriority('done'));
    assert.equal(statusPriority('some-unknown-status'), 9);
    for (const [status, entry] of Object.entries(STATUSES)) {
      assert.ok(entry.en && entry.zh && Number.isInteger(entry.priority), `complete entry for ${status}`);
    }
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

  it('rolls a yearly reset forward and resolves ambiguous clock times', () => {
    const now = Date.parse('2030-10-10T00:00:00Z');
    assert.equal(
      resetEpoch('weekly limit; resets Oct 9, 10am UTC', now),
      Date.parse('2031-10-09T10:00:00Z'),
    );
    assert.equal(
      resetEpoch('usage limit resets 5 (UTC)', Date.parse('2030-01-01T04:00:00Z')),
      Date.parse('2030-01-01T05:00:00Z'),
    );
  });

  it('falls back when nothing parses', () => {
    assert.equal(resetEpoch('some random text', 1_000, 500), 1_500);
  });
});

describe('token estimate', () => {
  it('estimates conservatively from byte count (rounds up, floors at zero)', () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(4), 1);
    assert.equal(estimateTokens(5), 2);
    assert.equal(estimateTokens(-10), 0);
  });
});

describe('idle and bricked detection', () => {
  it('flags permission-blocked replies as idle but leaves normal work alone', () => {
    assert.equal(looksIdle("I don't have permission to run that command."), true);
    assert.equal(looksIdle('Please grant access to continue.'), true);
    assert.equal(looksIdle('Fixed the bug and ran the tests, all green.'), false);
  });

  it('flags the previous_message_id corruption signature as bricked', () => {
    assert.equal(looksBricked('400: diagnostics.previous_message_id not found'), true);
    assert.equal(looksBricked('normal assistant output'), false);
  });
});

describe('structured CLI result parsing', () => {
  it('parses a successful --output-format json result', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: 'Fixed it.', num_turns: 3, total_cost_usd: 0.12 });
    const parsed = parseCliJsonResult(stdout);
    assert.equal(parsed.isError, false);
    assert.equal(parsed.resultText, 'Fixed it.');
    assert.equal(parsed.numTurns, 3);
    assert.equal(parsed.totalCostUsd, 0.12);
  });

  it('recognizes an error via is_error or an error-prefixed subtype', () => {
    assert.equal(parseCliJsonResult(JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 429' })).isError, true);
    assert.equal(parseCliJsonResult(JSON.stringify({ type: 'result', subtype: 'error_during_execution', result: 'boom' })).isError, true);
  });

  it('returns null for non-JSON stdout so callers fall back to raw-text scanning', () => {
    assert.equal(parseCliJsonResult('plain text output'), null);
    assert.equal(parseCliJsonResult('{not valid json'), null);
    assert.equal(parseCliJsonResult('null'), null);
  });
});

describe('probe classification (classifyProbe)', () => {
  it('trusts a non-error JSON result with exit 0 without banner-scanning the reply text', () => {
    const { verdict } = classifyProbe({
      code: 0,
      stdout: JSON.stringify({ type: 'result', is_error: false, result: 'Done. Will try again in 5 seconds when the queue is full.' }),
      stderr: '',
    });
    assert.equal(verdict, 'resumed', 'reply text discussing retries must not be misread as a limit');
  });

  it('classifies limit banners inside an error result and in raw output', () => {
    assert.equal(classifyProbe({
      code: 1,
      stdout: JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 4pm" }),
    }).verdict, 'still-limited');
    assert.equal(classifyProbe({ code: 1, stdout: "You've hit your session limit · resets 4pm" }).verdict, 'still-limited');
    assert.equal(classifyProbe({ code: 1, stdout: '', stderr: 'API Error 529: service overloaded' }).verdict, 'overload');
    assert.equal(classifyProbe({ code: 1, stdout: 'segfault' }).verdict, 'other-failure');
  });
});

describe('codex stream scanning', () => {
  it('finds the thread id even when the JSONL line is split across chunks', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'split-thread' }) + '\n';
    const scanner = codexStreamScanner();
    scanner.push(line.slice(0, 18));
    assert.equal(scanner.thread, null, 'half a line is not yet a thread id');
    scanner.push(line.slice(18));
    assert.equal(scanner.thread, 'split-thread');
  });

  it('keeps only the bounded tail while preserving an already-captured thread', () => {
    const scanner = codexStreamScanner(64);
    scanner.push(JSON.stringify({ type: 'thread.started', thread_id: 'early' }) + '\n');
    scanner.push('x'.repeat(500));
    assert.equal(scanner.thread, 'early', 'thread survives tail truncation');
    assert.ok(scanner.tail.length <= 64);
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
