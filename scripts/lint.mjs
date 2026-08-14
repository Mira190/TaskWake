#!/usr/bin/env node
// Zero-dependency lint: `node --check` every JS file, then parse the browser JS embedded in
// dashboard-page.js (which `node --check` cannot see inside the template string — a merge
// once shipped a broken statement seam there that only a browser would have caught).
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

const root = new URL('..', import.meta.url).pathname;
const failures = [];

async function collect(dir) {
  let entries = [];
  try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && /\.(js|mjs)$/.test(entry.name))
    .map((entry) => join(dir, entry.name));
}

const files = (await Promise.all(['src', 'bin', 'test', 'bench', 'scripts'].map(collect))).flat();
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' }); }
  catch (error) { failures.push(`${file}: ${error.stderr?.toString().trim() || error.message}`); }
}

const { dashboardPage } = await import(join(root, 'src/dashboard-page.js'));
const scripts = [...dashboardPage.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length === 0) failures.push('dashboard-page.js: no <script> block found — extraction regex broken?');
for (const [index, match] of scripts.entries()) {
  try { new vm.Script(match[1], { filename: `dashboard-page-embedded-${index}.js` }); }
  catch (error) { failures.push(`dashboard-page.js embedded script #${index}: ${error.message}`); }
}

if (failures.length) {
  console.error(`lint: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`lint: ${files.length} files + ${scripts.length} embedded dashboard script(s) OK`);
