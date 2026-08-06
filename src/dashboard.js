import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanId, pathsOverlap } from './core.js';
import { t } from './i18n.js';
import { home, pendingDir, doneDir, sessionsDir, loadConfig, log, openTerminal, readJson, tailLog } from './store.js';
import { dashboardPage } from './dashboard-page.js';

const ralphDir = join(home, 'ralph');
const transcriptCache = new Map();
const opening = new Set();

async function listJson(dir) {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    return (await Promise.all(names.map((name) => readJson(join(dir, name))))).filter(Boolean);
  } catch { return []; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const compact = (value, max = 360) => String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

async function findTranscript(session) {
  const cached = transcriptCache.get(session);
  if (cached && Date.now() - cached.at < 60_000) return cached.path;
  let path;
  try {
    const root = join(homedir(), '.claude', 'projects');
    const names = await readdir(root, { recursive: true });
    const suffix = `${session}.jsonl`.toLowerCase();
    const match = names.find((name) => String(name).toLowerCase().endsWith(suffix));
    if (match) path = join(root, match);
  } catch { /* Claude storage is optional */ }
  transcriptCache.set(session, { path, at: Date.now() });
  return path;
}

async function tailText(path, bytes = 160_000) {
  if (!path) return '';
  let handle;
  try {
    handle = await open(path, 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString();
  } catch { return ''; }
  finally { await handle?.close(); }
}

function toolDetail(block) {
  const input = block?.input || {};
  return compact(input.description || input.command || input.file_path || input.path || input.pattern || input.query || Object.values(input).find((value) => typeof value === 'string'));
}

async function readActivity(path) {
  const raw = await tailText(path);
  if (!raw) return [];
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        events.push({ kind: 'tool', label: block.name || 'Tool', detail: toolDetail(block), at: row.timestamp });
      } else if (block?.type === 'text' && row.type === 'assistant') {
        const detail = compact(block.text);
        if (detail) events.push({ kind: 'claude', label: 'Claude', detail, at: row.timestamp });
      } else if (block?.type === 'tool_result') {
        const detail = compact(typeof block.content === 'string' ? block.content : 'Tool completed');
        events.push({ kind: block.is_error ? 'error' : 'result', label: block.is_error ? 'Tool error' : 'Tool result', detail, at: row.timestamp });
      }
    }
  }
  return events.slice(-10).reverse();
}

function statusFor(item) {
  if (item.pending) {
    if (alive(item.pending.probePid)) return 'running';
    if (alive(item.pending.waiterPid)) return 'waiting';
    return 'orphaned';
  }
  if (item.registry?.status === 'active') return alive(item.registry.claudePid) ? 'active' : 'stale';
  if (item.done) return item.done.status || 'done';
  return item.registry?.status || 'ended';
}

export async function buildSnapshot() {
  const [registries, pending, done, ralph] = await Promise.all([
    listJson(sessionsDir), listJson(pendingDir), listJson(doneDir), listJson(ralphDir),
  ]);
  const map = new Map();
  const get = (session) => {
    if (!map.has(session)) map.set(session, { session });
    return map.get(session);
  };
  for (const record of registries) if (record.session) get(record.session).registry = record;
  for (const record of pending) if (record.session) get(record.session).pending = record;
  for (const record of done) if (record.session) get(record.session).done = record;
  for (const record of ralph) if (record.session) get(record.session).ralph = record;

  const sessions = [];
  for (const item of map.values()) {
    const source = item.pending || item.registry || item.done || {};
    const transcriptPath = source.transcriptPath || item.registry?.transcriptPath || item.done?.transcriptPath || await findTranscript(item.session);
    const activity = await readActivity(transcriptPath);
    let transcriptAt = 0;
    try { transcriptAt = (await stat(transcriptPath)).mtimeMs; } catch { /* no transcript */ }
    const updatedAt = Math.max(transcriptAt,
      item.registry?.updatedAt || 0, item.pending?.nextTry || 0, item.pending?.receivedAt || 0,
      item.done?.finishedAt || 0, item.ralph?.updatedAt || 0,
    );
    sessions.push({
      session: item.session,
      cwd: source.cwd || item.registry?.cwd || item.done?.cwd,
      model: item.registry?.model,
      permissionMode: item.registry?.permissionMode,
      claudePid: item.registry?.claudePid,
      waiterPid: item.pending?.waiterPid,
      probePid: item.pending?.probePid,
      nextTry: item.pending?.nextTry,
      attempts: item.pending?.attempts,
      probes: item.pending?.probes,
      errorType: item.pending?.errorType || item.done?.errorType,
      ralphTurns: item.ralph?.turns,
      status: statusFor(item),
      updatedAt,
      transcriptPath,
      activity,
    });
  }

  const writing = sessions.filter((item) => ['active', 'running'].includes(item.status) && item.cwd);
  let conflicts = 0;
  for (let left = 0; left < writing.length; left++) {
    for (let right = left + 1; right < writing.length; right++) {
      if (!pathsOverlap(writing[left].cwd, writing[right].cwd)) continue;
      writing[left].conflict = true;
      writing[right].conflict = true;
      conflicts++;
    }
  }

  const priority = {
    running: 0, active: 1, waiting: 2, orphaned: 3, stale: 4, ended: 5, opened: 6, resumed: 7, 'resumed-idle': 7,
    bricked: 8, failed: 8, 'gave-up': 8, 'skipped-weekly-budget': 8, done: 9,
  };
  sessions.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || b.updatedAt - a.updatedAt);
  return {
    generatedAt: Date.now(),
    summary: {
      active: sessions.filter((item) => ['active', 'running'].includes(item.status)).length,
      waiting: sessions.filter((item) => ['waiting', 'orphaned'].includes(item.status)).length,
      ralph: sessions.filter((item) => item.ralphTurns && ['active', 'running', 'waiting', 'orphaned'].includes(item.status)).length,
      conflicts,
    },
    sessions: sessions.slice(0, 30),
    logs: await tailLog(50),
  };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => {});
    child.unref();
  } catch { /* opening is best-effort */ }
}

// Host-header allowlist blocks DNS-rebinding (a hostile page pointing a browser's fetch at a
// domain that resolves to 127.0.0.1); the per-launch token blocks other local accounts on a
// shared machine from reading session/transcript activity just by guessing the fixed port.
function isLoopbackHost(host = '') {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

export function canOpenSession(item) {
  return item && !['active', 'running', 'waiting', 'orphaned'].includes(item.status);
}

async function openSessionTerminal(item) {
  const config = await loadConfig(item.cwd);
  await openTerminal([...config.claudeCmd, '--resume', item.session], item.cwd || homedir());
}

async function readBody(request, limit = 4_096) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw new Error('Request too large');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function startDashboard({ port = 4178, open = true } = {}) {
  const token = randomBytes(16).toString('hex');
  let dashboardOrigin;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!isLoopbackHost(request.headers.host)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.searchParams.get('token') !== token) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden: missing or invalid token');
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(dashboardPage);
      return;
    }
    if (url.pathname === '/api') {
      try {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(await buildSnapshot()));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (url.pathname === '/api/open' && request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        if (request.headers.origin !== dashboardOrigin || request.headers['x-taskwake-action'] !== 'open-session') {
          response.writeHead(403);
          response.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        const { session } = await readBody(request);
        if (typeof session !== 'string' || session.length > 128 || cleanId(session) !== session) throw new Error('Invalid session');
        const item = (await buildSnapshot()).sessions.find((entry) => entry.session === session);
        if (!item) {
          response.writeHead(404);
          response.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        if (!canOpenSession(item) || opening.has(session)) {
          response.writeHead(409);
          response.end(JSON.stringify({ error: 'Session is already controlled by TaskWake or Claude' }));
          return;
        }
        opening.add(session);
        const release = setTimeout(() => opening.delete(session), 10_000);
        release.unref();
        try { await openSessionTerminal(item); }
        catch (error) { opening.delete(session); throw error; }
        await log(`interactive takeover opened session=${session}`);
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  dashboardOrigin = `http://127.0.0.1:${server.address().port}`;
  const url = `${dashboardOrigin}/?token=${token}`;
  // Expose the tokenized URL so tests (and embedders) can reach the authed endpoints
  // without scraping stdout; the raw origin alone is intentionally not enough.
  server.taskwakeUrl = url;
  process.stdout.write(t(`TaskWake dashboard: ${url}\n`, `TaskWake 控制台：${url}\n`));
  if (open) openBrowser(url);
  return server;
}