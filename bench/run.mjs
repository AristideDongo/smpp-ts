#!/usr/bin/env node
// Benchmarks for smpp-ts, run against the built package (what users install).
//
//   node bench/run.mjs                      # every benchmark, table output
//   node bench/run.mjs --json out.json      # also writes the results as JSON
//   node bench/run.mjs --dist ../base/dist  # benchmarks another build (CI comparison)
//   node bench/run.mjs --quick              # fewer messages, for a fast check
//
// No dependency: node:perf_hooks and the library itself.

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: 'dist' },
    json: { type: 'string' },
    quick: { type: 'boolean', default: false },
    runs: { type: 'string', default: '3' },
    only: { type: 'string' },
  },
});

const lib = await import(pathToFileURL(resolve(args.dist, 'index.js')).href);
const { SmppServer, SmppClient, encodePdu, decodePdu, Framer, encodeGsm7, buildParts, parseDlr } = lib;

const RUNS = Math.max(1, Number(args.runs));
const QUICK = args.quick;

// ---------------------------------------------------------------- helpers

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Runs `fn` in a loop for about `ms` milliseconds, returns operations per second. */
function opsPerSecond(fn, ms = QUICK ? 150 : 500) {
  for (let i = 0; i < 1000; i++) fn(); // warm-up (JIT)
  let ops = 0;
  const start = performance.now();
  let elapsed = 0;
  while (elapsed < ms) {
    for (let i = 0; i < 100; i++) fn();
    ops += 100;
    elapsed = performance.now() - start;
  }
  return (ops / elapsed) * 1000;
}

// ---------------------------------------------------------------- end-to-end

const submit = {
  source_addr: 'SENDER',
  destination_addr: '2250700000000',
  short_message: Buffer.from('Your code is 123456'),
};

async function withPair(window, fn) {
  let id = 0;
  const server = new SmppServer({
    authenticate: () => true,
    handlers: { submit_sm: () => ({ message_id: String(++id) }) },
    inboundWindow: window,
    maxSessionsPerIp: 1000,
  });
  const { port } = await server.listen(0, '127.0.0.1');
  const client = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'bench', password: 'bench' },
    window,
    maxQueueSize: 1_000_000,
    requestTimeout: 120_000,
    enquireLinkInterval: 0,
    reconnect: false,
    retry: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** submit_sm/s, client and server in the same process over loopback TCP. */
async function throughput(window, count) {
  return withPair(window, async (client) => {
    // Warm-up
    await Promise.all(Array.from({ length: Math.min(2_000, count) }, () => client.submit(submit)));
    const start = performance.now();
    if (window === 1) {
      for (let i = 0; i < count; i++) await client.submit(submit);
    } else {
      await Promise.all(Array.from({ length: count }, () => client.submit(submit)));
    }
    return (count / (performance.now() - start)) * 1000;
  });
}

/** Round trip latency of one submit_sm at a time (window 1). */
async function latency(count) {
  return withPair(1, async (client) => {
    for (let i = 0; i < 500; i++) await client.submit(submit);
    const samples = new Array(count);
    for (let i = 0; i < count; i++) {
      const t = performance.now();
      await client.submit(submit);
      samples[i] = performance.now() - t;
    }
    samples.sort((a, b) => a - b);
    return { p50: percentile(samples, 50), p99: percentile(samples, 99) };
  });
}

// ---------------------------------------------------------------- codec and utilities

const submitPdu = encodePdu({ command: 'submit_sm', sequence_number: 1, ...submit });
const stream = Buffer.concat(Array.from({ length: 1000 }, () => submitPdu));
const gsmText = 'Hello! Your verification code is 123456. It expires in 10 minutes. Do not share it.'.repeat(
  2,
);
const longUcs2 = 'Votre commande est confirmée 🎉 '.repeat(12);
const dlrText =
  'id:0123456789 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:Hello';

const micro = {
  'encode submit_sm': () => encodePdu({ command: 'submit_sm', sequence_number: 1, ...submit }),
  'decode submit_sm': () => decodePdu(submitPdu),
  'frame 1000 PDUs': () => new Framer().push(stream),
  'GSM7 encode (160 chars)': () => encodeGsm7(gsmText.slice(0, 160)),
  'split UCS2 text (6 parts)': () => buildParts(longUcs2, { reference: 1 }),
  'parse DLR text': () => parseDlr(dlrText),
};

// ---------------------------------------------------------------- main

const results = { meta: {}, e2e: {}, latency: {}, micro: {} };
results.meta = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
  cores: os.cpus().length,
  runs: RUNS,
  quick: QUICK,
};

const want = (name) => !args.only || name.includes(args.only);

for (const window of [1, 10, 50]) {
  const name = `submit_sm/s, window ${window}`;
  if (!want(name)) continue;
  const count = QUICK ? (window === 1 ? 2_000 : 10_000) : window === 1 ? 10_000 : 50_000;
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await throughput(window, count));
  results.e2e[name] = { median: median(runs), best: Math.max(...runs), runs };
}

if (want('latency')) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await latency(QUICK ? 1_000 : 5_000));
  results.latency['round trip, window 1'] = {
    p50: median(runs.map((r) => r.p50)),
    p99: median(runs.map((r) => r.p99)),
  };
}

for (const [name, fn] of Object.entries(micro)) {
  if (!want(name)) continue;
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(opsPerSecond(fn));
  results.micro[name] = { median: median(runs), best: Math.max(...runs), runs };
}

// ---------------------------------------------------------------- output

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const m = results.meta;
console.log(`smpp-ts benchmarks · Node ${m.node} · ${m.cpu} (${m.cores} cores) · ${m.runs} run(s)\n`);
const rows = [
  ...Object.entries(results.e2e).map(([k, v]) => [k, `${fmt(v.median)} msg/s`, `best ${fmt(v.best)}`]),
  ...Object.entries(results.latency).map(([k, v]) => [
    k,
    `p50 ${v.p50.toFixed(3)} ms`,
    `p99 ${v.p99.toFixed(3)} ms`,
  ]),
  ...Object.entries(results.micro).map(([k, v]) => [k, `${fmt(v.median)} ops/s`, `best ${fmt(v.best)}`]),
];
const w0 = Math.max(...rows.map((r) => r[0].length));
const w1 = Math.max(...rows.map((r) => r[1].length));
for (const [a, b, c] of rows) console.log(`${a.padEnd(w0)}  ${b.padStart(w1)}  ${c}`);

if (args.json) {
  writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nResults written to ${args.json}`);
}
