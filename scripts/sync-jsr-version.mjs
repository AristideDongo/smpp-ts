#!/usr/bin/env node
// Copies the version of package.json into jsr.json (run after `changeset version`).
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const jsr = JSON.parse(readFileSync('jsr.json', 'utf8'));
if (jsr.version !== pkg.version) {
  jsr.version = pkg.version;
  writeFileSync('jsr.json', `${JSON.stringify(jsr, null, 2)}\n`);
  console.log(`jsr.json → ${pkg.version}`);
}
