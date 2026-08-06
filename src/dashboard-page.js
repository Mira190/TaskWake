export const dashboardPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TaskWake Control Room</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080d18;
      --surface: #0f172a;
      --surface-2: #172033;
      --border: #475569;
      --text: #f8fafc;
      --muted: #a8b3c7;
      --green: #4ade80;
      --green-bg: #0c2f22;
      --blue: #60a5fa;
      --blue-bg: #102a4c;
      --yellow: #fbbf24;
      --yellow-bg: #3b2c08;
      --red: #fb7185;
      --red-bg: #3b1420;
      --radius: 16px;
      --shadow: 0 18px 55px rgba(0, 0, 0, .28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background: radial-gradient(circle at 12% -10%, #172554 0, transparent 31rem), var(--bg);
      color: var(--text);
      font: 15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    button:focus-visible, a:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
    .shell { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 64px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
    .eyebrow { color: var(--green); font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 4px 0 5px; font-size: clamp(28px, 5vw, 46px); line-height: 1.08; letter-spacing: -.035em; }
    .lede { margin: 0; color: var(--muted); max-width: 700px; }
    .connection { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .live { display: inline-flex; align-items: center; gap: 8px; color: var(--green); font-weight: 750; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; box-shadow: 0 0 14px currentColor; }
    .button { min-height: 44px; padding: 9px 15px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-2); color: var(--text); cursor: pointer; transition: border-color .18s ease, background-color .18s ease; }
    .button:hover { border-color: var(--blue); background: #1e293b; }
    .button:disabled { cursor: not-allowed; opacity: .58; border-color: var(--border); background: var(--surface-2); }
    .button.small { min-height: 44px; padding: 7px 12px; font-size: 13px; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .metric { padding: 18px; border: 1px solid #334155; border-radius: var(--radius); background: rgba(15, 23, 42, .9); box-shadow: var(--shadow); }
    .metric-label { color: var(--muted); font-size: 13px; }
    .metric-value { margin-top: 3px; font-size: 30px; line-height: 1.15; font-weight: 800; letter-spacing: -.04em; }
    .metric[data-kind="active"] .metric-value { color: var(--green); }
    .metric[data-kind="waiting"] .metric-value { color: var(--blue); }
    .metric[data-kind="ralph"] .metric-value { color: #c4b5fd; }
    .metric[data-kind="conflicts"] .metric-value { color: var(--yellow); }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 28px 0 12px; }
    h2 { margin: 0; font-size: 18px; }
    .meta, .muted { color: var(--muted); }
    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .card { min-width: 0; padding: 20px; border: 1px solid #334155; border-left: 4px solid var(--border); border-radius: var(--radius); background: rgba(15, 23, 42, .94); box-shadow: var(--shadow); }
    .card[data-status="active"], .card[data-status="running"] { border-left-color: var(--green); }
    .card[data-status="waiting"], .card[data-status="orphaned"] { border-left-color: var(--blue); }
    .card[data-status="stale"], .card[data-status="failed"] { border-left-color: var(--red); }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .path { min-width: 0; font-weight: 750; font-size: 16px; overflow-wrap: anywhere; }
    .session-id { margin-top: 3px; color: var(--muted); font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .pill { flex: none; display: inline-flex; align-items: center; min-height: 30px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; font-weight: 800; }
    .pill[data-status="active"], .pill[data-status="running"] { color: var(--green); background: var(--green-bg); border-color: #166534; }
    .pill[data-status="waiting"], .pill[data-status="orphaned"] { color: #93c5fd; background: var(--blue-bg); border-color: #1d4ed8; }
    .pill[data-status="stale"], .pill[data-status="failed"] { color: var(--red); background: var(--red-bg); border-color: #9f1239; }
    .warning { margin-top: 14px; padding: 11px 13px; border: 1px solid #a16207; border-radius: 10px; color: #fde68a; background: var(--yellow-bg); }
    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 18px; margin: 16px 0; }
    .fact { min-width: 0; }
    .fact dt { color: var(--muted); font-size: 12px; }
    .fact dd { margin: 1px 0 0; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .activity { margin: 14px 0 0; padding: 0; list-style: none; border-top: 1px solid #253047; }
    .activity li { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 10px; padding: 10px 0; border-bottom: 1px solid #253047; }
    .activity-kind { color: var(--blue); font-size: 12px; font-weight: 800; }
    .activity-detail { color: #d9e2f1; min-width: 0; overflow-wrap: anywhere; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .empty { padding: 36px 24px; border: 1px dashed var(--border); border-radius: var(--radius); color: var(--muted); text-align: center; background: rgba(15, 23, 42, .55); }
    .logs { max-height: 320px; overflow: auto; margin: 0; padding: 18px; border: 1px solid #334155; border-radius: var(--radius); background: #070b13; color: #b7c3d8; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .offline { color: var(--red); }
    @media (max-width: 820px) {
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cards { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 22px, 1280px); padding-top: 20px; }
      .topbar { flex-direction: column; }
      .connection { justify-content: flex-start; }
      .metrics { gap: 9px; }
      .metric { padding: 15px; }
      .facts { grid-template-columns: 1fr; }
      .activity li { grid-template-columns: 72px minmax(0, 1fr); }
    }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <div id="eyebrow" class="eyebrow">Local agent continuity</div>
        <h1 id="title">TaskWake Control Room</h1>
        <p id="lede" class="lede">Monitor Claude sessions, usage waits, automatic resumptions, and Ralph turns. Safely reopen idle sessions in a terminal.</p>
      </div>
      <div class="connection">
        <span id="live" class="live"><span class="dot" aria-hidden="true"></span><span id="live-text">Connected locally</span></span>
        <button id="refresh" class="button" type="button">Refresh now</button>
      </div>
    </header>

    <section id="metrics" class="metrics" aria-label="Runtime summary"></section>

    <div class="section-head">
      <h2 id="sessions-title">Claude sessions</h2>
      <span id="updated" class="meta" aria-live="polite">Loading…</span>
    </div>
    <section id="sessions" class="cards" aria-label="Claude session list"></section>

    <div class="section-head">
      <h2 id="logs-title">TaskWake decision log</h2>
      <span id="logs-meta" class="meta">Latest 50 lines</span>
    </div>
    <pre id="logs" class="logs" tabindex="0">Loading…</pre>
  </main>

  <script>
    const chinese = (navigator.language || '').toLowerCase().startsWith('zh');
    const locale = chinese ? 'zh-CN' : 'en';
    const dictionary = {
      en: {
        eyebrow: 'Local agent continuity', title: 'TaskWake Control Room',
        lede: 'Monitor Claude sessions, usage waits, automatic resumptions, and Ralph turns. Safely reopen idle sessions in a terminal.',
        connected: 'Connected locally', refresh: 'Refresh now', summary: 'Runtime summary', sessions: 'Claude sessions',
        sessionList: 'Claude session list', loading: 'Loading…', logs: 'TaskWake decision log', latest: 'Latest 50 lines',
        status: {
          active: 'Active', running: 'Resuming', waiting: 'Waiting to retry', orphaned: 'Awaiting recovery',
          stale: 'Process missing', ended: 'Ended', opened: 'Opened in terminal', resumed: 'Resumed',
          'resumed-idle': 'Resumed (possibly idle)', bricked: 'Session corrupted', 'gave-up': 'Retry stopped',
          'skipped-weekly': 'Weekly limit', 'skipped-context': 'Manual reopen needed',
          'skipped-weekly-budget': 'Weekly budget ceiling reached', failed: 'Resume failed', done: 'Completed',
        },
        metrics: [['active', 'Running'], ['waiting', 'Waiting / repair'], ['ralph', 'Ralph loops'], ['conflicts', 'Directory conflicts']],
        unknownCwd: 'Unknown working directory', conflict: 'Concurrency risk: multiple Claude sessions are working in the same or nested directory and may edit the same files.',
        resumePid: 'Resume PID', permission: 'Permission mode', model: 'Model', ralphTurns: 'Ralph turns', nextRetry: 'Next retry', failures: 'Failures', probes: 'Usage probes', lastActivity: 'Last activity',
        activity: 'Recent transcript activity', completed: 'Completed', noActivity: 'No transcript activity yet. It appears automatically after a new session starts.',
        open: 'Open session', opening: 'Opening…', opened: 'Terminal opened', busy: 'Already controlled', openFailed: 'Could not open',
        copy: 'Copy resume command', copied: 'Copied', copyFailed: 'Copy failed', empty: 'No sessions recorded yet. Start a Claude session and it will appear here automatically.',
        noLogs: 'No TaskWake logs yet.', updated: 'Updated ', disconnected: 'Disconnected; retrying'
      },
      zh: {
        eyebrow: '本地智能体连续运行', title: 'TaskWake 控制中心',
        lede: '集中查看 Claude 会话、额度等待、自动续跑与 Ralph 轮次，并安全地在终端重新打开空闲会话。',
        connected: '本机已连接', refresh: '立即刷新', summary: '运行摘要', sessions: 'Claude 会话',
        sessionList: 'Claude 会话列表', loading: '正在读取…', logs: 'TaskWake 决策日志', latest: '最近 50 行',
        status: {
          active: '活动中', running: '自动续跑中', waiting: '等待重试', orphaned: '等待恢复', stale: '进程已失联',
          ended: '已结束', opened: '已在终端打开', resumed: '已续跑', 'resumed-idle': '已续跑（可能未实际工作）',
          bricked: '会话已损坏', 'gave-up': '已停止重试', 'skipped-weekly': '每周限额',
          'skipped-context': '需手动重开', 'skipped-weekly-budget': '已达每周续跑上限', failed: '续跑失败', done: '已完成',
        },
        metrics: [['active', '正在运行'], ['waiting', '等待 / 待修复'], ['ralph', 'Ralph 循环'], ['conflicts', '目录冲突']],
        unknownCwd: '工作目录未知', conflict: '并发风险：多个 Claude 正在相同或嵌套目录中运行，可能同时修改相同文件。',
        resumePid: '续跑 PID', permission: '权限模式', model: '模型', ralphTurns: 'Ralph 轮次', nextRetry: '下次重试', failures: '失败次数', probes: '额度探测', lastActivity: '最后活动',
        activity: '最近会话活动', completed: '已完成', noActivity: '尚未读取到会话活动。新会话启动后会自动出现。',
        open: '打开会话', opening: '正在打开…', opened: '终端已打开', busy: '正在被接管', openFailed: '无法打开',
        copy: '复制恢复命令', copied: '已复制', copyFailed: '复制失败', empty: '还没有会话记录。启动 Claude 后会自动显示。',
        noLogs: '暂无 TaskWake 日志。', updated: '更新于 ', disconnected: '连接中断，正在重试'
      }
    };
    const text = dictionary[chinese ? 'zh' : 'en'];
    document.documentElement.lang = chinese ? 'zh-CN' : 'en';
    document.title = text.title;
    document.getElementById('eyebrow').textContent = text.eyebrow;
    document.getElementById('title').textContent = text.title;
    document.getElementById('lede').textContent = text.lede;
    document.getElementById('live-text').textContent = text.connected;
    document.getElementById('refresh').textContent = text.refresh;
    document.getElementById('metrics').setAttribute('aria-label', text.summary);
    document.getElementById('sessions-title').textContent = text.sessions;
    document.getElementById('sessions').setAttribute('aria-label', text.sessionList);
    document.getElementById('updated').textContent = text.loading;
    document.getElementById('logs-title').textContent = text.logs;
    document.getElementById('logs-meta').textContent = text.latest;
    document.getElementById('logs').textContent = text.loading;

    const el = (tag, className, value) => {
      const item = document.createElement(tag);
      if (className) item.className = className;
      if (value !== undefined) item.textContent = value;
      return item;
    };
    const when = (value) => value ? new Date(value).toLocaleString(locale) : '—';
    const pid = (value) => value ? String(value) : '—';

    function fact(label, value) {
      const wrap = el('div', 'fact');
      wrap.append(el('dt', '', label), el('dd', '', value || '—'));
      return wrap;
    }

    function renderMetrics(summary) {
      const root = document.getElementById('metrics');
      root.replaceChildren(...text.metrics.map(([key, label]) => {
        const card = el('div', 'metric');
        card.dataset.kind = key;
        card.append(el('div', 'metric-label', label), el('div', 'metric-value', String(summary[key] || 0)));
        return card;
      }));
    }

    function renderSession(item) {
      const card = el('article', 'card');
      card.dataset.status = item.status;
      const head = el('div', 'card-head');
      const identity = el('div');
      identity.append(el('div', 'path', item.cwd || text.unknownCwd), el('div', 'session-id', item.session));
      const pill = el('span', 'pill', text.status[item.status] || item.status);
      pill.dataset.status = item.status;
      head.append(identity, pill);
      card.append(head);

      if (item.conflict) card.append(el('div', 'warning', text.conflict));

      const facts = el('dl', 'facts');
      facts.append(
        fact('Claude PID', pid(item.claudePid)), fact(text.resumePid, pid(item.probePid || item.waiterPid)),
        fact(text.permission, item.permissionMode || '—'), fact(text.model, item.model || '—'),
        fact(text.ralphTurns, item.ralphTurns ? String(item.ralphTurns) : '—'), fact(text.nextRetry, when(item.nextTry)),
        fact(text.failures, item.attempts === undefined ? '—' : String(item.attempts)),
        fact(text.probes, item.probes === undefined ? '—' : String(item.probes)), fact(text.lastActivity, when(item.updatedAt))
      );
      card.append(facts);

      if (item.activity && item.activity.length) {
        const title = el('div', 'muted', text.activity);
        const list = el('ol', 'activity');
        for (const event of item.activity) {
          const row = el('li');
          row.append(el('span', 'activity-kind', event.label), el('span', 'activity-detail', event.detail || text.completed));
          list.append(row);
        }
        card.append(title, list);
      } else card.append(el('div', 'muted', text.noActivity));

      const actions = el('div', 'actions');
      const open = el('button', 'button small', text.open);
      open.type = 'button';
      open.disabled = ['active', 'running', 'waiting', 'orphaned'].includes(item.status);
      if (open.disabled) {
        open.textContent = text.busy;
        open.title = text.busy;
      }
      open.addEventListener('click', async () => {
        open.disabled = true;
        open.textContent = text.opening;
        try {
          const response = await fetch('/api/open?token=' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-TaskWake-Action': 'open-session' },
            body: JSON.stringify({ session: item.session })
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          open.textContent = text.opened;
        } catch {
          open.textContent = text.openFailed;
          open.disabled = false;
        }
      });      const copy = el('button', 'button small', text.copy);
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText('claude --resume ' + item.session);
          copy.textContent = text.copied;
          setTimeout(() => { copy.textContent = text.copy; }, 1500);
        } catch { copy.textContent = text.copyFailed; }
      });
      actions.append(open, copy);
      card.append(actions);
      return card;
    }

    function render(data) {
      renderMetrics(data.summary);
      const sessions = document.getElementById('sessions');
      if (data.sessions.length) sessions.replaceChildren(...data.sessions.map(renderSession));
      else sessions.replaceChildren(el('div', 'empty', text.empty));
      document.getElementById('logs').textContent = data.logs || text.noLogs;
      document.getElementById('updated').textContent = text.updated + new Date(data.generatedAt).toLocaleTimeString(locale);
      const live = document.getElementById('live');
      live.classList.remove('offline');
      live.lastElementChild.textContent = text.connected;
    }

    const token = new URLSearchParams(location.search).get('token') || '';
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch('/api?token=' + encodeURIComponent(token), { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        render(await response.json());
      } catch {
        const live = document.getElementById('live');
        live.classList.add('offline');
        live.lastElementChild.textContent = text.disconnected;
      } finally { loading = false; }
    }
    document.getElementById('refresh').addEventListener('click', refresh);
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;