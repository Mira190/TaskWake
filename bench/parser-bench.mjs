#!/usr/bin/env node
// Scores banner classification and reset parsing against bench/fixtures/eval-corpus.json,
// and compares the waiter's two classification strategies end-to-end:
//   raw        — failureKind over the full combined stdout+stderr (pre-1.x behaviour)
//   structured — parseCliJsonResult first, scan only the reply text + stderr (current)
// Usage: node bench/parser-bench.mjs [label]   (label defaults to the current git rev)
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { classifyProbe, failureKind, isWeekly, resetEpoch } from '../src/core.js';

const corpus = JSON.parse(await readFile(new URL('./fixtures/eval-corpus.json', import.meta.url), 'utf8'));
const label = process.argv[2] || execSync('git rev-parse --short HEAD').toString().trim();
const NOW = Date.parse('2030-01-15T00:00:00Z');

// --- banner classification + parse accuracy ---------------------------------
let kindHits = 0;
let weeklyHits = 0;
let parseHits = 0;
let parseTotal = 0;
for (const { text, kind = null, weekly = false, parses = false } of corpus.banners) {
  if ((failureKind(text) ?? null) === kind) kindHits++;
  if (isWeekly(text) === weekly) weeklyHits++;
  if (parses) {
    parseTotal++;
    if (resetEpoch(text, NOW, 999) !== NOW + 999) parseHits++;
  }
}

// --- false positives on benign successful-turn output ------------------------
let benignFalsePositives = 0;
for (const { text } of corpus.benign) {
  if (failureKind(text) !== undefined) benignFalsePositives++;
}

// --- end-to-end strategy comparison on structured samples ---------------------
function verdictRaw(sample) {
  const kind = failureKind(`${sample.stdout}\n${sample.stderr}`);
  if (sample.code === 0 && !kind) return 'resumed';
  return kind === 'usage' ? 'still-limited' : kind === 'overload' ? 'overload' : 'other-failure';
}
// The structured strategy IS the production classifier (core.classifyProbe) — the bench
// scores the exact code the waiter runs, not a re-implementation that could drift.
function verdictStructured(sample) {
  return classifyProbe(sample).verdict;
}
const strategies = { raw: verdictRaw, structured: verdictStructured };
const strategyScores = {};
for (const [name, judge] of Object.entries(strategies)) {
  let hits = 0;
  const misses = [];
  for (const sample of corpus.structured) {
    const got = judge(sample);
    if (got === sample.verdict) hits++;
    else misses.push({ name: sample.name, expected: sample.verdict, got });
  }
  strategyScores[name] = { correct: hits, total: corpus.structured.length, misses };
}

// --- throughput (sanity only; parsing is not a hot path) ----------------------
function opsPerSec(fn, arg, iterations = 20_000) {
  fn(arg); // warm
  const start = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) fn(arg);
  const nanos = Number(process.hrtime.bigint() - start);
  return Math.round(iterations / (nanos / 1e9));
}
const sampleBanner = corpus.banners[0].text;
const throughput = {
  failureKindOpsPerSec: opsPerSec(failureKind, sampleBanner),
  resetEpochOpsPerSec: opsPerSec((text) => resetEpoch(text, NOW), sampleBanner),
};

const result = {
  label,
  at: new Date().toISOString(),
  node: process.version,
  classification: {
    kindAccuracy: `${kindHits}/${corpus.banners.length}`,
    weeklyAccuracy: `${weeklyHits}/${corpus.banners.length}`,
    parseRecall: `${parseHits}/${parseTotal}`,
    benignFalsePositives: `${benignFalsePositives}/${corpus.benign.length}`,
  },
  strategies: strategyScores,
  throughput,
};
console.log(JSON.stringify(result, null, 2));
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL(`./results/parser-${label}.json`, import.meta.url), JSON.stringify(result, null, 2));
