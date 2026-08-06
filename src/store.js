import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaults } from './core.js';

const userHome = homedir();
const modernHome = join(userHome, '.taskwake');
const legacyHome = join(userHome, '.rewake');
export const home = process.env.TASKWAKE_HOME || process.env.REWAKE_HOME
  || (existsSync(legacyHome) && !existsSync(modernHome) ? legacyHome : modernHome);
export const pendingDir = join(home, 'pending');
export const doneDir = join(home, 'done');
export const sessionsDir = join(home, 'sessions');
const legacyLog = join(home, 'rewake.log');
const logFile = existsSync(legacyLog) ? legacyLog : join(home, 'taskwake.log');
const modernConfig = join(userHome, '.taskwake.json');
const legacyConfig = join(userHome, '.rewake.json');
const configFile = process.env.TASKWAKE_CONFIG || process.env.REWAKE_CONFIG
  || (existsSync(legacyConfig) && !existsSync(modernConfig) ? legacyConfig : modernConfig);

function applyOverrides(config, raw) {
  for (const key of ['marginMs', 'fallbackMs', 'maxAttempts', 'maxContextResume', 'maxContextResumeTokens', 'weeklyResumeCeiling']) {
    if (Number.isFinite(raw[key]) && raw[key] >= 0) config[key] = raw[key];
  }
  for (const key of ['usagePollMs', 'usageResumeSpacingMs']) {
    if (Number.isFinite(raw[key]) && raw[key] > 0) config[key] = raw[key];
  }
  if (typeof raw.retryText === 'string' && raw.retryText.trim()) config.retryText = raw.retryText;
  if (['hybrid', 'headless'].includes(raw.resumeMode)) config.resumeMode = raw.resumeMode;
  if (Array.isArray(raw.overloadMs) && raw.overloadMs.length && raw.overloadMs.every((item) => Number.isFinite(item) && item > 0)) {
    config.overloadMs = raw.overloadMs;
  }
  if (Array.isArray(raw.claudeCmd) && raw.claudeCmd.length && raw.claudeCmd.every((item) => typeof item === 'string')) {
    config.claudeCmd = raw.claudeCmd;
  }
  if (Array.isArray(raw.ralphTaskFiles) && raw.ralphTaskFiles.length && raw.ralphTaskFiles.every((item) => typeof item === 'string' && item.trim())) {
    config.ralphTaskFiles = raw.ralphTaskFiles;
  }
  if (typeof raw.ralph === 'boolean') config.ralph = raw.ralph;
  if (Number.isInteger(raw.ralphMaxTurns) && raw.ralphMaxTurns > 0) config.ralphMaxTurns = raw.ralphMaxTurns;
  if (['notify', 'resume'].includes(raw.weeklyPolicy)) config.weeklyPolicy = raw.weeklyPolicy;
  if (['toast', 'none'].includes(raw.notify)) config.notify = raw.notify;
  return config;
}

// Global ~/.taskwake.json first, then an optional project-local .taskwake.json (in `cwd`)
// layered on top — lets one project opt in/out of e.g. ralph without changing the machine-wide
// default. `cwd` is optional so existing single-argument call sites are unaffected.
export async function loadConfig(cwd) {
  let config = { ...defaults };
  try {
    config = applyOverrides(config, JSON.parse(await readFile(configFile, 'utf8')));
  } catch { /* no global config file */ }
  if (cwd) {
    try {
      config = applyOverrides(config, JSON.parse(await readFile(join(cwd, '.taskwake.json'), 'utf8')));
    } catch { /* no project config file */ }
  }
  return config;
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
}

export async function listJson(dir) {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    return (await Promise.all(names.map((name) => readJson(join(dir, name))))).filter(Boolean);
  } catch { return []; }
}

export function aliveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}`;
  await writeFile(temporary, JSON.stringify(value, null, 1));
  await rename(temporary, path);
}

export async function log(text) {
  await mkdir(home, { recursive: true });
  await appendFile(logFile, `${new Date().toISOString()} ${text}\n`);
}

export async function tailLog(lines = 80) {
  try { return (await readFile(logFile, 'utf8')).split(/\r?\n/).slice(-lines).join('\n'); }
  catch { return ''; }
}

// ponytail: on Windows, npm shims are .cmd files that spawn() refuses without a shell
// (CVE-2024-27980), so join through cmd.exe there; embedded quotes are stripped because
// cmd.exe quoting has no safe escape — args here are our own flags and config strings.
export function shellSpawn(argv, options = {}) {
  if (process.platform !== 'win32') return spawn(argv[0], argv.slice(1), options);
  const line = argv.map((item) => `"${String(item).replaceAll('"', '')}"`).join(' ');
  return spawn(line, { ...options, shell: true, windowsHide: true });
}

export function runCommand(argv, options = {}) {
  return new Promise((resolve) => {
    const { onSpawn, ...spawnOptions } = options;
    const child = shellSpawn(argv, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    onSpawn?.(child.pid);
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (part) => stdout.push(part));
    child.stderr?.on('data', (part) => stderr.push(part));
    child.once('error', (error) => resolve({ code: 1, stdout: '', stderr: error.message }));
    child.once('exit', (code) => resolve({
      code: Number.isInteger(code) ? code : 1,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    }));
  });
}

export async function canShowTerminal(env = process.env, platform = process.platform, probe = runCommand) {
  if (platform === 'win32') {
    if (/^(services|session 0)$/i.test(env.SESSIONNAME || '')) return false;
    if (env.SESSIONNAME || env.WT_SESSION || env.TERM_PROGRAM) return true;
    const script = '$current=(Get-Process -Id $PID).SessionId; if(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $current){exit 0}else{exit 1}';
    try { return (await probe(['powershell.exe', '-NoProfile', '-Command', script])).code === 0; }
    catch { return false; }
  }
  if (platform === 'darwin') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function openTerminal(argv, cwd = homedir()) {
  let command;
  if (process.platform === 'win32') {
    const line = argv.map((part) => `"${String(part).replaceAll('"', '')}"`).join(' ');
    command = ['cmd.exe', ['/d', '/c', 'start', '', 'cmd.exe', '/d', '/k', line]];
  } else if (process.platform === 'darwin') {
    const line = `cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(' ')}`;
    command = ['osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`]];
  } else {
    command = ['x-terminal-emulator', ['-e', ...argv]];
  }
  const child = spawn(command[0], command[1], { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
    child.once('error', reject);
  });
}

const toastScript = (title, body) => `
$m=[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t=$x.GetElementsByTagName('text')
$null=$t.Item(0).AppendChild($x.CreateTextNode('${title}'))
$null=$t.Item(1).AppendChild($x.CreateTextNode('${body}'))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('TaskWake').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

export function notify(title, body, config = defaults) {
  if (config.notify === 'none') return;
  const clean = (value) => String(value).replace(/['"`$\\]/g, '');
  try {
    let child;
    if (process.platform === 'darwin') {
      child = spawn('osascript', ['-e', `display notification "${clean(body)}" with title "${clean(title)}"`], { stdio: 'ignore', detached: true });
    } else if (process.platform === 'win32') {
      child = spawn('powershell', ['-NoProfile', '-Command', toastScript(clean(title), clean(body))], { stdio: 'ignore', detached: true });
    } else {
      child = spawn('notify-send', [clean(title), clean(body)], { stdio: 'ignore', detached: true });
    }
    child.once('error', () => {});
    child.unref();
  } catch { /* notifications are best-effort; the log is the source of truth */ }
}
