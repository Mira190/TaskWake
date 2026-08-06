import { resolve, sep } from 'node:path';

const HOUR = 3_600_000;

export const defaults = Object.freeze({
  marginMs: 60_000,
  fallbackMs: 5 * HOUR,
  usagePollMs: HOUR,
  usageResumeSpacingMs: 5 * 60_000,
  retryText: 'Continue from the interruption.',
  resumeMode: 'hybrid',
  maxAttempts: 4,
  overloadMs: [30_000, 60_000, 120_000, 240_000, 300_000],
  maxContextResume: 2_000_000,
  maxContextResumeTokens: 200_000,
  weeklyResumeCeiling: 50,
  weeklyPolicy: 'notify',
  notify: 'toast',
  claudeCmd: ['claude'],
  ralph: false,
  ralphMaxTurns: 20,
  ralphTaskFiles: ['TODO.md', 'REVIEW_AND_HANDOFF.md', 'GAME_DESIGN.md'],
});

// Rough, conservative token estimate from a byte count (~4 bytes/token for English text).
// JSON structural overhead in a transcript pushes the true ratio higher (fewer tokens per
// byte), so this over-estimates tokens if anything — safe direction for a skip-resume gate.
export function estimateTokens(bytes = 0) {
  return Math.ceil(Math.max(0, bytes) / 4);
}

const idleWords = [
  /\bi (?:don't|do not|can't|cannot) (?:have|get) (?:permission|access)\b/i,
  /\bnot allowed to\b/i,
  /\brequires? (?:approval|permission)\b/i,
  /\bpermission denied\b/i,
  /\bplease (?:grant|enable) (?:permission|access)\b/i,
  /\bwaiting for (?:your |user )?(?:approval|permission)\b/i,
];

// Heuristic only: flags a "successful" (exit 0) resume whose final text reads like the
// model was blocked by tool permissions rather than doing real work. False negatives are
// expected (many valid replies never mention permissions); it exists to annotate, not gate.
export function looksIdle(text = '') {
  return idleWords.some((pattern) => pattern.test(text));
}

const brickedWords = [/\bprevious_message_id\b/i];

// Matches the upstream "resume permanently corrupts the session" failure signature
// (anthropics/claude-code #76008 / #68553): retrying it burns attempts on something that
// cannot succeed, so the waiter should recognize it and stop instead of exhausting maxAttempts.
export function looksBricked(text = '') {
  return brickedWords.some((pattern) => pattern.test(text));
}

// Parses `claude ... --output-format json` stdout structurally so the waiter can classify a
// completed turn without regex-scanning the model's own (possibly rate-limit-discussing)
// reply text. Returns null when stdout isn't a single JSON result object, so callers can fall
// back to the legacy full-text scan for older CLI versions or hard failures that never print JSON.
export function parseCliJsonResult(stdout = '') {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  let value;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const isError = value.is_error === true || (typeof value.subtype === 'string' && value.subtype.startsWith('error'));
  return {
    isError,
    resultText: typeof value.result === 'string' ? value.result : '',
    numTurns: Number.isFinite(value.num_turns) ? value.num_turns : undefined,
    totalCostUsd: Number.isFinite(value.total_cost_usd) ? value.total_cost_usd : undefined,
  };
}

const usageWords = [
  /\b\d+-hour limit\b/i,
  /\b(?:usage|session|weekly) limit\b/i,
  /\bhit (?:your|the) limit\b/i,
  /\bout of extra usage\b/i,
  /\brate limit(?:ed| reached| hit)?\b[\s\S]{0,200}\breset/i,
  /\btry again (?:in|at)\b/i,
];

const overloadWords = [
  /\bapi error\s*:?[ ]*429\b|\b429\b.{0,80}\brate limit/i,
  /\bapi error\s*:?[ ]*(?:500|502|503|504|529)\b/i,
  /\b(?:500|502|503|504|529)\b.*\b(?:api|error|overload|upstream)\b/i,
  /\b(?:overloaded_error|server_error)\b/i,
  /\btemporarily limiting requests\b/i,
];

export function failureKind(text = '') {
  if (usageWords.some((pattern) => pattern.test(text))) return 'usage';
  if (overloadWords.some((pattern) => pattern.test(text))) return 'overload';
  return undefined;
}

export function isWeekly(text = '') {
  return /\bweekly limit\b|\b7-day\b|\bseven-day\b/i.test(text);
}

function zoneOffset(epoch, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(epoch);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - epoch;
}

function clockEpoch(hour, minute, zone, now) {
  if (!zone) {
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() < now - 120_000) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const day = calendar.formatToParts(now);
  const value = Object.fromEntries(day.map(({ type, value: item }) => [type, Number(item)]));
  const wall = Date.UTC(value.year, value.month - 1, value.day, hour, minute);
  let epoch = wall - zoneOffset(wall, zone);
  epoch = wall - zoneOffset(epoch, zone);
  if (epoch < now - 120_000) {
    const tomorrow = wall + 24 * HOUR;
    epoch = tomorrow - zoneOffset(tomorrow, zone);
    epoch = tomorrow - zoneOffset(epoch, zone);
  }
  return epoch;
}

// ponytail: parsed times are hints, not truth — the waiter verifies by probing,
// so a wrong parse costs one bounded extra wait, never a lost night.
export function resetEpoch(message = '', now = Date.now(), fallbackMs = defaults.fallbackMs) {
  const relative = message.match(/(?:try again|reset\w*|wait)(?:\s+(?:at|in))?\s*:?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const scale = unit.startsWith('h') ? HOUR : unit.startsWith('m') ? 60_000 : 1_000;
    return now + Number(relative[1]) * scale;
  }

  const dated = message.match(/(?:try again at|resets?(?: at)?)\s+([A-Z][a-z]{2,8})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(?:(\d{4})\s+)?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+([A-Z]{2,5}))?/i);
  if (dated) {
    let year = Number(dated[3] || new Date(now).getFullYear());
    const time = dated[4].replace(/^(\d{1,2})(am|pm)$/i, '$1:00 $2').replace(/(\d:\d{2})(am|pm)$/i, '$1 $2');
    const parse = () => Date.parse(`${dated[1]} ${dated[2]}, ${year} ${time} ${dated[5] || ''}`);
    let epoch = parse();
    if (!dated[3] && epoch < now - 120_000) {
      year++;
      epoch = parse();
    }
    if (Number.isFinite(epoch)) return Math.max(now, epoch);
  }

  const clock = message.match(/reset\w*(?:\s+at|\s*:)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    if (hour <= 23 && minute <= 59) {
      if (clock[3]) hour = (hour % 12) + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
      if (!clock[3] && hour <= 12) {
        try {
          return Math.min(clockEpoch(hour % 12, minute, clock[4], now), clockEpoch((hour % 12) + 12, minute, clock[4], now));
        } catch { /* invalid zone */ }
      }
      try { return clockEpoch(hour, minute, clock[4], now); } catch { /* invalid zone */ }
    }
  }
  return now + fallbackMs;
}

export function codexExecIndex(args) {
  const values = new Set(['-c', '--config', '-C', '--cd', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--add-dir']);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === 'exec' || args[index] === 'e') return index;
    if (values.has(args[index])) index++;
    else if (!args[index].startsWith('-')) break;
  }
  return -1;
}

export function jsonCodexArgs(args) {
  if (args.includes('--json')) return args.slice();
  const index = codexExecIndex(args);
  return index < 0 ? args.slice() : [...args.slice(0, index + 1), '--json', ...args.slice(index + 1)];
}

export function readCodexJson(stream = '') {
  let thread = null;
  let message = null;
  for (const line of stream.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started') thread = event.thread_id || thread;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text;
    } catch { /* not JSONL */ }
  }
  return { thread, message };
}

export function codexResumeArgs(original, thread, prompt = defaults.retryText) {
  const exec = codexExecIndex(original);
  const leading = exec < 0 ? [] : original.slice(0, exec);
  const values = new Set(['--sandbox', '--color', '--output-schema', '--output-last-message', '--image', '--config']);
  const carried = [];
  for (let index = exec + 1; index < original.length; index++) {
    const option = original[index];
    if (!option.startsWith('-')) break;
    if (option === '--json' || option === '--ephemeral') continue;
    carried.push(option);
    if (values.has(option) && original[index + 1]) carried.push(original[++index]);
  }
  return [...leading, 'exec', 'resume', '--json', ...carried, thread || '--last', prompt];
}

export function pathsOverlap(left, right) {
  const normalize = (value) => {
    const path = resolve(value);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
export function cleanId(value = '') {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}
