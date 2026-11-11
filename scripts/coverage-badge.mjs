#!/usr/bin/env node
// Turns coverage/coverage-summary.json into a shields.io endpoint badge (docs-site/coverage-badge.json).
// No external service: the badge JSON is published with the documentation site.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const pct = summary.total.lines.pct;
const color = pct >= 90 ? 'brightgreen' : pct >= 80 ? 'green' : pct >= 70 ? 'yellow' : 'red';
mkdirSync('docs-site', { recursive: true });
writeFileSync(
  'docs-site/coverage-badge.json',
  `${JSON.stringify({ schemaVersion: 1, label: 'coverage', message: `${pct.toFixed(1)}%`, color })}\n`,
);
console.log(`coverage ${pct}%`);
