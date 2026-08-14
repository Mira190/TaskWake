#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanId, statusLabel } from '../src/core.js';
import { startDashboard } from '../src/dashboard.js';
import { runCodex } from '../src/codex.js';
import { chinese, locale, t } from '../src/i18n.js';
import { doneDir, listJson, loadConfig, pendingDir, tailLog } from '../src/store.js';

const statusName = (status) => statusLabel(status, chinese);

async function status() {
  const config = await loadConfig();
  const pending = await listJson(pendingDir);
  const done = (await listJson(doneDir)).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10);
  for (const item of pending) {
    const at = new Date(item.nextTry || (item.resetHint && item.resetHint + config.marginMs) || item.receivedAt).toLocaleString(locale);
    process.stdout.write(t(
      `pending  ${item.session}  ${item.errorType}  failures=${item.attempts}  next=${at}\n`,
      `等待中  ${item.session}  ${item.errorType}  失败=${item.attempts}  下次=${at}\n`,
    ));
  }
  for (const item of done) {
    const at = new Date(item.finishedAt).toLocaleString(locale);
    const cost = [
      item.numTurns !== undefined ? t(`turns=${item.numTurns}`, `轮次=${item.numTurns}`) : '',
      item.costUsd !== undefined ? `$${item.costUsd.toFixed(2)}` : '',
    ].filter(Boolean).join('  ');
    process.stdout.write(t(
      `${statusName(item.status)}  ${item.session}  ${item.errorType}  finished=${at}${cost ? '  ' + cost : ''}\n`,
      `${statusName(item.status)}  ${item.session}  ${item.errorType}  完成=${at}${cost ? '  ' + cost : ''}\n`,
    ));
  }
  if (!pending.length && !done.length) process.stdout.write(t('No TaskWake activity recorded.\n', '暂无 TaskWake 活动记录。\n'));
}

async function cancel(session) {
  if (!session) throw new Error(t('Usage: taskwake cancel <session-id>', '用法：taskwake cancel <会话 ID>'));
  await unlink(join(pendingDir, `${cleanId(session)}.json`));
  process.stdout.write(t(
    `Cancelled ${session}; its waiter exits within a minute.\n`,
    `已取消 ${session}；等待进程将在一分钟内退出。\n`,
  ));
}

const execute = promisify(execFile);
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function scheduler(remove = false) {
  if (process.platform !== 'win32') throw new Error(t('Boot recovery currently supports Windows only.', '开机恢复目前仅支持 Windows。'));
  const task = 'taskwake-reconcile';
  const legacyTask = 'rewake-reconcile';
  const hook = fileURLToPath(new URL('../src/hook.js', import.meta.url));
  const unregister = `Unregister-ScheduledTask -TaskName ${psQuote(task)} -Confirm:$false -ErrorAction SilentlyContinue\nUnregister-ScheduledTask -TaskName ${psQuote(legacyTask)} -Confirm:$false -ErrorAction SilentlyContinue`;
  const script = remove ? unregister : `${unregister}
$action=New-ScheduledTaskAction -Execute ${psQuote(process.execPath)} -Argument ${psQuote(`"${hook}" reconcile`)}
$boot=New-ScheduledTaskTrigger -AtStartup
$boot.Delay='PT30S'
$heartbeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName ${psQuote(task)} -Action $action -Trigger @($boot,$heartbeat) -Principal $principal -Settings $settings -Description ${psQuote(t('Re-arm TaskWake after boot and every five minutes', '开机后及每五分钟恢复 TaskWake 等待任务'))} -Force | Out-Null`;
  try {
    await execute('powershell', ['-NoProfile', '-Command', script]);
  } catch (error) {
    const detail = `${error.stderr || error.message}`;
    if (!remove && /access is denied|拒绝访问/i.test(detail)) {
      throw new Error(t(
        'Installing boot recovery needs one-time Administrator privileges. Re-run in an elevated terminal.',
        '安装开机恢复需要一次管理员权限，请在管理员终端中重新运行。',
      ));
    }
    throw error;
  }
  process.stdout.write(t(
    `${remove ? 'Removed' : 'Installed'} Windows boot recovery task ${task}.\n`,
    `已${remove ? '移除' : '安装'} Windows 开机恢复任务 ${task}。\n`,
  ));
}

function help() {
  process.stdout.write(t(`TaskWake — keep AI work moving

  status              list pending and recent resumptions
  logs                print the recent decision log
  dashboard [port]    open the local session control room
  cancel <session>    cancel a pending resumption
  install-scheduler   recover after boot and every 5m
  uninstall-scheduler remove Windows boot recovery
  run codex <args…>   run Codex batch work with usage-limit retry

Claude Code needs no wrapper: install the TaskWake plugin and its hooks handle recovery.
The legacy rewake command remains an alias.
`, `TaskWake — 让 AI 工作持续推进

  status              查看等待中及最近续跑的会话
  logs                查看最近决策日志
  dashboard [端口]    打开本机会话控制台
  cancel <会话>       取消等待中的续跑
  install-scheduler   安装开机及每 5 分钟恢复
  uninstall-scheduler 移除 Windows 开机恢复
  run codex <参数…>   运行带限额恢复的 Codex 批处理

Claude Code 无需包装命令：安装 TaskWake 插件后由 hooks 自动恢复。
旧 rewake 命令继续作为兼容别名。
`));
}

let exitCode = 0;
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'status') await status();
  else if (action === 'logs') process.stdout.write(await tailLog() + '\n');
  else if (action === 'dashboard') await startDashboard({ port: Number(args.find((arg) => /^\d+$/.test(arg))) || 4178, open: !args.includes('--no-open') });
  else if (action === 'cancel') await cancel(args[0]);
  else if (action === 'install-scheduler') await scheduler();
  else if (action === 'uninstall-scheduler') await scheduler(true);
  else if (action === 'run' && args[0] === 'codex') exitCode = await runCodex(args.slice(1), await loadConfig());
  else help();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  exitCode = 1;
}
process.exitCode = exitCode;