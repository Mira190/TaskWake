#!/usr/bin/env node
// Measures dashboard buildSnapshot() latency under the real polling pattern:
// the page polls /api every 2 seconds, and between most polls no transcript changed.
// Scenarios:
//   cold          — first snapshot (nothing cached)
//   warm-idle     — repeat snapshots, no transcript changed (the common case)
//   warm-churn    — repeat snapshots, one transcript appended to between polls
// Fixture: N registered sessions, each with a ~TRANSCRIPT_KB JSONL transcript.
// Usage: node bench/snapshot-bench.mjs [label] [sessions] [transcriptKb]
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const label = process.argv[2] || execSync('git rev-parse --short HEAD').toString().trim();
const SESSIONS = Number(process.argv[3]) || 30;
const TRANSCRIPT_KB = Number(process.argv[4]) || 200;
const REPS = 25;

const tmp = await mkdtemp(join(tmpdir(), 'taskwake-bench-'));
process.env.TASKWAKE_HOME = join(tmp, 'home');
process.env.TASKWAKE_CONFIG = join(tmp, 'config.json');
const { writeAtomic } = await import('../src/store.js');
const { buildSnapshot } = await import('../src/dashboard.js');

// One realistic transcript row is ~460 bytes; build rows until the target size is met.
const row = JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(),
  message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test --workspaces --verbose' } },
    { type: 'text', text: 'Running the suite and inspecting the failures before patching the module.' },
  ] },
}) + '\n';
const rows = row.repeat(Math.ceil((TRANSCRIPT_KB * 1024) / row.length));

const transcripts = [];
for (let index = 0; index < SESSIONS; index++) {
  const transcript = join(tmp, `session-${index}.jsonl`);
  await writeFile(transcript, rows);
  transcripts.push(transcript);
  await writeAtomic(join(process.env.TASKWAKE_HOME, 'sessions', `bench-${index}.json`), {
    session: `bench-${index}`, cwd: join(tmp, `project-${index}`), transcriptPath: transcript,
    claudePid: 999_999 + index, status: 'ended', updatedAt: Date.now(),
  });
}

async function measure(scenario, mutate) {
  const samples = [];
  for (let rep = 0; rep < REPS; rep++) {
    if (mutate) await mutate(rep);
    const start = process.hrtime.bigint();
    const snapshot = await buildSnapshot();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (snapshot.sessions.length === 0) throw new Error('empty snapshot — fixture broken');
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    scenario,
    reps: REPS,
    meanMs: Number((sum / samples.length).toFixed(2)),
    p50Ms: Number(samples[Math.floor(samples.length / 2)].toFixed(2)),
    maxMs: Number(samples[samples.length - 1].toFixed(2)),
  };
}

const cold = await measure('cold-first-snapshot');
const warmIdle = await measure('warm-idle');
const warmChurn = await measure('warm-churn', (rep) => appendFile(transcripts[rep % SESSIONS], row));

const result = {
  label,
  at: new Date().toISOString(),
  node: process.version,
  fixture: { sessions: SESSIONS, transcriptKb: TRANSCRIPT_KB },
  scenarios: [cold, warmIdle, warmChurn],
};
console.log(JSON.stringify(result, null, 2));
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL(`./results/snapshot-${label}-s${SESSIONS}.json`, import.meta.url), JSON.stringify(result, null, 2));
await rm(tmp, { recursive: true, force: true });
