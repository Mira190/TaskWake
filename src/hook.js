#!/usr/bin/env node
// StopFailure hook: record the interrupted session, then hand off to a detached waiter.
// StopFailure is side-effect only — nothing printed here reaches the session.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir, stat, unlink } from 'node:fs/promises';
import { cleanId, resetEpoch } from './core.js';
import { t } from './i18n.js';
import { loadConfig, log, pendingDir, readJson, sessionsDir, writeAtomic } from './store.js';

const kinds = { rate_limit: 'usage', overloaded: 'overload', server_error: 'overload' };
const ralphFile = (session) => join(dirname(pendingDir), 'ralph', `${cleanId(session)}.json`);

export async function saveEvent(input) {
  const errorType = input?.error ?? input?.error_type;
  const kind = kinds[errorType];
  const session = input?.session_id;
  if (!kind || !session) return undefined;
  const file = join(pendingDir, `${cleanId(session)}.json`);
  if (await readJson(file)) return undefined; // a waiter is already pending for this session
  const text = [input.error_details, input.last_assistant_message].filter(Boolean).join('\n');
  const parsedReset = kind === 'usage' ? resetEpoch(text, Date.now(), Number.NaN) : Number.NaN;
  let transcriptBytes = 0;
  try { transcriptBytes = (await stat(input.transcript_path)).size; } catch { /* no transcript */ }
  const record = {
    session,
    cwd: input.cwd,
    transcriptPath: input.transcript_path,
    kind,
    errorType,
    details: text.slice(0, 4_000),
    resetHint: Number.isFinite(parsedReset) ? parsedReset : 0,
    resetParsed: Number.isFinite(parsedReset),
    transcriptBytes,
    receivedAt: Date.now(),
    attempts: 0,
  };
  await writeAtomic(file, record);
  await log(`hook ${errorType} session=${session}`);
  return record;
}

export async function trackSession(input, ended = false, claudePid = process.ppid) {
  const session = input?.session_id;
  if (!session) return undefined;
  const file = join(sessionsDir, `${cleanId(session)}.json`);
  const previous = await readJson(file);
  const record = {
    ...previous,
    session,
    cwd: input.cwd || previous?.cwd,
    transcriptPath: input.transcript_path || previous?.transcriptPath,
    permissionMode: input.permission_mode || previous?.permissionMode,
    model: input.model || previous?.model,
    source: input.source || previous?.source,
    claudePid,
    status: ended ? 'ended' : 'active',
    updatedAt: Date.now(),
  };
  if (ended) record.reason = input.reason;
  await writeAtomic(file, record);
  if (ended) await unlink(ralphFile(session)).catch(() => {});
  return record;
}
export function startWaiter(session) {
  const waiter = join(dirname(fileURLToPath(import.meta.url)), 'waiter.js');
  const child = spawn(process.execPath, [waiter, session], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.once('error', () => {});
  child.unref();
}

function aliveProcess(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Re-arm waiters orphaned by a reboot or logout. Runs from the SessionStart hook,
// so recovery is event-driven: no daemon, no timer to install or repair.
export async function reconcile() {
  let names = [];
  try { names = (await readdir(pendingDir)).filter((name) => name.endsWith('.json')); } catch { return 0; }
  let spawned = 0;
  for (const name of names) {
    const state = await readJson(join(pendingDir, name));
    if (!state?.session) continue;
    if (state.waiterPid && aliveProcess(state.waiterPid)) continue; // ponytail: pid-reuse can false-skip; next reconcile retries
    if (state.probePid && aliveProcess(state.probePid)) continue; // parent died, but its Claude continuation is still working
    if (!state.waiterPid && Date.now() - state.receivedAt < 120_000) continue; // fresh entry, its spawner is still claiming it
    startWaiter(state.session);
    spawned++;
    await log(`reconcile respawned waiter session=${state.session}`);
  }
  return spawned;
}

export async function ralph(input, config) {
  const session = input?.session_id;
  if (!session) return undefined;
  config ||= await loadConfig();
  if (!config.ralph) return undefined;
  const file = ralphFile(session);
  const previous = await readJson(file);
  const turns = (previous?.turns || 0) + 1;
  const done = /\[RALPH_DONE\]/i.test(input.last_assistant_message || '');
  if (done || turns >= config.ralphMaxTurns) {
    await unlink(file).catch(() => {});
    await log(`ralph stopped session=${session} reason=${done ? 'done' : 'max-turns'} turns=${turns}`);
    return undefined;
  }
  await writeAtomic(file, { session, turns, updatedAt: Date.now() });
  await log(`ralph continued session=${session} turn=${turns}`);
  return {
    decision: 'block',
    reason: t(
      `Ralph loop turn ${turns}/${config.ralphMaxTurns}: continue autonomously. Finish and verify the current task. If complete, inspect TODO.md, REVIEW_AND_HANDOFF.md, GAME_DESIGN.md, tests, and the working tree; execute the highest-priority safe local task already implied by them. Make reversible project-local choices without asking. Do not invent scope, modify global Claude settings, deploy, publish, push, change credentials, spend money, or terminate processes you did not start. Never mass-kill by process name. When no safe local task remains, end with [RALPH_DONE].`,
      `Ralph 循环 ${turns}/${config.ralphMaxTurns}：自主继续。完成并验证当前任务；如果已经完成，请检查 TODO.md、REVIEW_AND_HANDOFF.md、GAME_DESIGN.md、测试和工作树，执行其中已明确的最高优先级安全本地任务。对可逆的项目内选择自行决定，无需询问。不得擅自扩大范围、修改 Claude 全局设置、部署、发布、推送、修改凭据、花费资金或终止本轮未启动的进程；不得按进程名批量终止。没有安全本地任务时以 [RALPH_DONE] 结束。`,
    ),
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'reconcile') { await reconcile(); return; }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  // strip a UTF-8 BOM: Windows pipes (PowerShell) prepend one and JSON.parse chokes on it
  const text = Buffer.concat(chunks).toString();
  try { input = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text); }
  catch (error) {
    process.stderr.write(t(`TaskWake hook: unreadable input: ${error.message}\n`, `TaskWake hook：无法读取输入：${error.message}\n`)); // visible with claude --debug
    return;
  }
  if (mode === 'session-start') {
    await trackSession(input);
    await reconcile();
    return;
  }
  if (mode === 'session-end') {
    await trackSession(input, true);
    return;
  }
  if (mode === 'ralph') {
    const output = await ralph(input);
    if (output) process.stdout.write(JSON.stringify(output));
    return;
  }
  if (!(await saveEvent(input))) return;
  startWaiter(input.session_id);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
