#!/usr/bin/env node
// One short-lived process per interrupted session: wait, probe, and verify.
// Usage sessions share one durable gate so several Claudes never probe the same account together.
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanId, failureKind, isWeekly, resetEpoch } from './core.js';
import { t } from './i18n.js';
import { canShowTerminal, doneDir, home, loadConfig, log, notify, openTerminal, pendingDir, readJson, runCommand, writeAtomic } from './store.js';

const CHUNK = 60_000; // local cancellation/clock check; this never calls Claude
const GATE_STALE_MS = 2 * 60_000;
const gateFile = join(home, 'usage-gate.json');
const gateLock = `${gateFile}.lock`;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const jitter = (base, spread = 0.15) => Math.round(base * (1 - spread + Math.random() * spread * 2));

async function editGate(change, retry = true) {
  await mkdir(home, { recursive: true });
  let handle;
  try { handle = await open(gateLock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (retry) {
      try {
        if (Date.now() - (await stat(gateLock)).mtimeMs > GATE_STALE_MS) {
          await unlink(gateLock);
          return editGate(change, false);
        }
      } catch { /* another waiter repaired it */ }
    }
    return undefined;
  }
  try { return await change((await readJson(gateFile)) || {}); }
  finally {
    await handle.close();
    await unlink(gateLock).catch(() => {});
  }
}

export async function claimUsageProbe(session, config, now = Date.now()) {
  const reservedUntil = now + jitter(config.usagePollMs, 0.08);
  const claim = await editGate(async (gate) => {
    if ((gate.nextProbeAt || 0) > now) return { claimed: false, nextTry: gate.nextProbeAt };
    await writeAtomic(gateFile, {
      ...gate, owner: session, lastProbeAt: now, nextProbeAt: reservedUntil, updatedAt: now,
    });
    return { claimed: true, nextTry: reservedUntil };
  });
  if (claim) return claim;
  const gate = await readJson(gateFile);
  return { claimed: false, nextTry: Math.max(now + CHUNK, gate?.nextProbeAt || 0) };
}

async function setUsageGate(session, nextProbeAt, result) {
  await editGate(async (gate) => writeAtomic(gateFile, {
    ...gate, owner: session, nextProbeAt, lastResult: result, updatedAt: Date.now(),
  }));
}

const MAX_AHEAD_MS = 8 * 24 * 3_600_000;
const capped = (epoch, now) => (epoch - now > MAX_AHEAD_MS ? Number.NaN : epoch);

// The deadline moves only on new provider information; see README "How it works".
export function initialDeadline(state, config) {
  const now = state.receivedAt || Date.now();
  if (state.kind === 'overload') return { deadline: now, trusted: false, tooFar: false };
  let parsed = Number.NaN;
  if (state.resetParsed === true && Number.isFinite(state.resetHint)) parsed = state.resetHint;
  else if (state.resetParsed === undefined) parsed = resetEpoch(state.details, now, Number.NaN);
  const tooFar = Number.isFinite(parsed) && Number.isNaN(capped(parsed, now));
  if (tooFar) return { deadline: now + config.fallbackMs + config.marginMs, trusted: false, tooFar };
  const trusted = Number.isFinite(parsed);
  const hint = trusted ? parsed : (state.resetHint || now + config.fallbackMs);
  return { deadline: hint + config.marginMs, trusted, tooFar };
}

function nextUsageCheck(deadline, config, now = Date.now()) {
  return Math.max(now, Math.min(deadline, now + jitter(config.usagePollMs, 0.08)));
}

// Trust Claude's JSON envelope over regexes: a successful answer may mention "rate limit".
export function evaluateProbe({ code, stdout = '', stderr = '' }) {
  const trimmed = stdout.trim();
  let envelope;
  try { envelope = JSON.parse(trimmed); } catch {
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      try {
        const row = JSON.parse(line);
        if (row?.type === 'result') { envelope = row; break; }
      } catch { /* not JSON */ }
    }
  }
  if (typeof envelope?.is_error === 'boolean') {
    if (!envelope.is_error) return { ok: true, kind: undefined, text: '' };
    const text = `${envelope.result ?? envelope.subtype ?? ''}\n${stderr}`;
    return { ok: false, kind: failureKind(text), text };
  }
  const text = `${stdout}\n${stderr}`;
  const kind = failureKind(text);
  return { ok: code === 0 && !kind, kind, text };
}

export async function shouldOpenTerminal(kind, mode, deadline, now = Date.now(), env = process.env, platform = process.platform, probe, oversized = false) {
  return (kind === 'usage' || (kind === 'overload' && oversized)) && mode !== 'headless' && now >= deadline
    && await canShowTerminal(env, platform, probe);
}

export async function wait(session, config) {
  const file = join(pendingDir, `${cleanId(session)}.json`);
  const state = await readJson(file);
  if (!state) return undefined;
  state.waiterPid = process.pid;
  state.attempts ||= 0;
  state.probes ||= 0;

  const finish = async (status, extra = {}) => {
    const record = { ...state, status, finishedAt: Date.now(), ...extra };
    await writeAtomic(join(doneDir, `${cleanId(session)}.json`), record);
    await unlink(file).catch(() => {});
    await log(`${status} session=${session}`);
    return record;
  };

  if (state.kind === 'usage' && isWeekly(state.details) && config.weeklyPolicy !== 'resume') {
    notify('TaskWake', t(`Weekly limit hit; not auto-resuming. Reopen later: claude --resume ${session}`, `已达到每周限额，未自动续跑。稍后重新打开：claude --resume ${session}`), config);
    return finish('skipped-weekly');
  }
  const oversized = state.transcriptBytes > config.maxContextResume;

  let { deadline, trusted, tooFar } = initialDeadline(state, config);
  if (tooFar) await log(`reset hint ignored (too far) session=${session}`);
  // Trusted usage deadlines are never probed early; oversized transcripts cannot go
  // headless, so they have nothing to gain from speculative probes either.
  const sleepUntil = (now = Date.now()) => (state.kind !== 'usage'
    ? now + jitter(config.overloadMs[Math.min(state.attempts, config.overloadMs.length - 1)])
    : trusted || oversized ? deadline : nextUsageCheck(deadline, config, now));
  let until = sleepUntil();
  state.nextTry = until;
  await writeAtomic(file, state);

  while (state.attempts < config.maxAttempts) {
    while (Date.now() < until) {
      await pause(Math.min(CHUNK, until - Date.now()));
      if (!(await readJson(file))) return undefined;
    }

    const wasUsage = state.kind === 'usage';
    if (wasUsage) {
      const gate = await claimUsageProbe(session, config);
      if (!gate.claimed) {
        until = gate.nextTry;
        state.nextTry = until;
        await writeAtomic(file, state);
        continue;
      }
    }

    if (await shouldOpenTerminal(state.kind, config.resumeMode, deadline, Date.now(), process.env, process.platform, undefined, oversized)) {
      try {
        const terminalPid = await openTerminal([...config.claudeCmd, '--resume', session, config.retryText], state.cwd);
        if (wasUsage) await setUsageGate(session, Date.now() + config.usageResumeSpacingMs, 'opened');
        notify('TaskWake', t('Session opened in a terminal.', '会话已在终端中打开。'), config);
        return finish('opened', { attempts: state.probes, terminalPid });
      } catch (error) {
        await log(`visible resume failed session=${session} error=${error.message}; falling back headless`);
      }
    }
    if (oversized) {
      notify('TaskWake', t(`Transcript too large for efficient headless resume. Reopen: claude --resume ${session}`, `会话记录过大，不适合无头续跑。重新打开：claude --resume ${session}`), config);
      return finish('skipped-context');
    }

    state.probes++;
    const started = Date.now();
    await log(`probe session=${session} probe=${state.probes} failures=${state.attempts}`);
    const result = await runCommand(
      [...config.claudeCmd, '--resume', session, '-p', config.retryText, '--output-format', 'json'],
      {
        ...(state.cwd ? { cwd: state.cwd } : {}),
        onSpawn: (pid) => {
          state.probePid = pid;
          writeAtomic(file, state).catch(() => {});
        },
      },
    );
    const { ok, kind, text: combined } = evaluateProbe(result);
    if (ok) {
      if (wasUsage) await setUsageGate(session, Date.now() + config.usageResumeSpacingMs, 'resumed');
      notify('TaskWake', t(`Session resumed. Reopen: claude --resume ${session}`, `会话已续跑。重新打开：claude --resume ${session}`), config);
      return finish('resumed', { attempts: state.probes });
    }

    const now = Date.now();
    if (kind === 'usage') {
      state.kind = 'usage';
      const raw = resetEpoch(combined, now, Number.NaN);
      const parsed = capped(raw, now);
      if (Number.isFinite(raw) && !Number.isFinite(parsed)) await log(`reset hint ignored (too far) session=${session}`);
      if (started < deadline) { // speculative: the provider window had not reset yet
        if (Number.isFinite(parsed)) {
          deadline = parsed + config.marginMs;
          trusted = true;
        }
        until = sleepUntil(now);
      } else {
        state.attempts++;
        trusted = Number.isFinite(parsed);
        deadline = trusted ? parsed + config.marginMs : now + jitter(config.usagePollMs, 0.08);
        until = deadline;
      }
      until = Math.max(until, now + Math.min(CHUNK, config.usagePollMs)); // never hot-loop a limited account
      await setUsageGate(session, until, trusted ? 'still-limited' : 'limit-time-unknown');
    } else {
      state.attempts++;
      if (kind) state.kind = kind;
      until = now + jitter(config.overloadMs[Math.min(state.attempts, config.overloadMs.length - 1)]);
      if (wasUsage) await setUsageGate(session, Math.max(now + CHUNK, until), kind || `exit-${result.code}`);
    }

    Object.assign(state, { nextTry: until, lastError: combined.slice(-1_000) });
    await writeAtomic(file, state);
    await log(`still blocked session=${session} kind=${kind || 'exit ' + result.code} next=${new Date(until).toISOString()}`);
  }

  notify('TaskWake', t(`Stopped after ${config.maxAttempts} failed attempts. Reopen: claude --resume ${session}`, `连续失败 ${config.maxAttempts} 次后已停止。重新打开：claude --resume ${session}`), config);
  return finish('gave-up');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await wait(process.argv[2], await loadConfig());
}