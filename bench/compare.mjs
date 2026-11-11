#!/usr/bin/env node
// Compares two benchmark results (bench/run.mjs --json) taken on the same machine.
//
//   node bench/compare.mjs base.json head.json [--threshold 0.25]
//
// Fails (exit code 1) when a throughput drops by more than `threshold` (25% by default).
// Uses the best run of each side: it is the least sensitive to noise on a shared CI runner.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { threshold: { type: 'string', default: '0.25' } },
});
if (positionals.length !== 2) {
  console.error('usage: node bench/compare.mjs base.json head.json [--threshold 0.25]');
  process.exit(2);
}
const [base, head] = positionals.map((p) => JSON.parse(readFileSync(p, 'utf8')));
const threshold = Number(values.threshold);

const rows = [];
let failed = false;
for (const group of ['e2e', 'micro']) {
  for (const [name, h] of Object.entries(head[group] ?? {})) {
    const b = base[group]?.[name];
    if (!b) {
      rows.push([name, '—', fmt(h.best), 'new', '']);
      continue;
    }
    const change = h.best / b.best - 1;
    const regressed = change < -threshold;
    failed ||= regressed;
    rows.push([name, fmt(b.best), fmt(h.best), pct(change), regressed ? '❌ regression' : '']);
  }
}

console.log('| Benchmark | Base | Head | Change | |');
console.log('|---|---:|---:|---:|---|');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
console.log(
  failed
    ? `\nThroughput dropped by more than ${pct(-threshold)} on at least one benchmark.`
    : `\nNo regression over ${pct(-threshold)}.`,
);
process.exit(failed ? 1 : 0);

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function pct(x) {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}
