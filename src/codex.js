// Codex batch path: `taskwake run codex exec …` — stream output through live while
// scanning a rolling tail for usage failures, then resume the exact thread.
import { codexResumeArgs, failureKind, jsonCodexArgs, readCodexJson, resetEpoch } from './core.js';
import { locale, t } from './i18n.js';
import { shellSpawn } from './store.js';

const TAIL = 65_536;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Pass chunks through live while keeping a bounded tail
// for failure detection and capturing the thread id the moment it appears.
function streamCodex(args) {
  return new Promise((resolve) => {
    const child = shellSpawn(['codex', ...args], { stdio: ['inherit', 'pipe', 'pipe'] });
    let tail = '';
    let thread = null;
    const watch = (target) => (part) => {
      target.write(part);
      tail = (tail + part).slice(-TAIL);
      thread ||= readCodexJson(String(part)).thread;
    };
    child.stdout.on('data', watch(process.stdout));
    child.stderr.on('data', watch(process.stderr));
    child.once('error', (error) => { process.stderr.write(`${error.message}\n`); resolve({ code: 1, tail, thread }); });
    child.once('exit', (code) => resolve({ code: code ?? 1, tail, thread }));
  });
}

export async function runCodex(originalArgs, config) {
  let args = jsonCodexArgs(originalArgs);
  let thread = null;
  for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
    const result = await streamCodex(args);
    thread ||= result.thread;
    if (failureKind(result.tail) !== 'usage') return result.code;
    if (attempt === config.maxAttempts) return 1;
    if (originalArgs.includes('--ephemeral')) {
      process.stderr.write(t('Cannot resume an ephemeral Codex thread.\n', '无法续跑临时 Codex 线程。\n'));
      return 1;
    }
    const until = resetEpoch(result.tail, Date.now(), config.fallbackMs) + config.marginMs;
    process.stderr.write(t(`Usage window reached; retrying at ${new Date(until).toLocaleString(locale)}.\n`, `已达到额度窗口；将在 ${new Date(until).toLocaleString(locale)} 重试。\n`));
    await pause(Math.max(0, until - Date.now()));
    args = codexResumeArgs(originalArgs, thread, config.retryText);
  }
  return 1;
}
