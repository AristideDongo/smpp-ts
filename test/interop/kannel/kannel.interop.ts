// Compatibility suite against Kannel (https://www.kannel.org/), the open source SMS gateway:
//
//   HTTP sendsms ──▶ Kannel smsbox ──▶ Kannel bearerbox (SMPP client) ──▶ smpp-ts SmppServer
//   smpp-ts SmppServer ──▶ bearerbox ──▶ smsbox ──▶ get-url / dlr-url (HTTP server of this test)
//
// Needs the `bearerbox` and `smsbox` binaries (Ubuntu / Debian package `kannel`, 1.4.5).
// Skipped unless KANNEL=1. See test/interop/kannel/README.md.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PduOf, type ServerSession, SmppServer, decodeMessageContent } from '../../../src/index.js';

const enabled = process.env.KANNEL === '1';
// Directory of bearerbox / smsbox: /usr/sbin on Debian and Ubuntu (often not in a user's PATH), else PATH.
const BIN = process.env.KANNEL_BIN ?? (existsSync('/usr/sbin/bearerbox') ? '/usr/sbin' : '');
const SYSTEM_ID = 'kannel';
const PASSWORD = 'secret';
const SHORT = 'Hello from Kannel';
// Cyrillic: UCS2, 3 segments of 67 characters.
const LONG = 'Привет мир! '.repeat(16).trim();
const MO = 'MO from smpp-ts';

interface Submitted {
  messageId: string;
  text: string;
  reference?: number;
  total: number;
  sequence: number;
  dataCoding: number;
}

interface HttpHit {
  path: string;
  query: URLSearchParams;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitUntil(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!enabled)('Kannel 1.4.5 → smpp-ts server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smppts-kannel-'));
  const submitted: Submitted[] = [];
  const hits: HttpHit[] = [];
  const binds: string[] = [];
  const closed: string[] = [];
  const processes: ChildProcess[] = [];
  let sessions: ServerSession<unknown>[] = [];
  let server: SmppServer<unknown>;
  let web: http.Server;
  let ports: { smpp: number; admin: number; smsbox: number; sendsms: number; web: number };
  let nextId = 1;

  const logs = () => {
    for (const f of ['bearerbox.log', 'smsbox.log']) {
      try {
        console.error(`----- ${f}\n${readFileSync(join(dir, f), 'utf8').split('\n').slice(-80).join('\n')}`);
      } catch {}
    }
  };

  beforeAll(async () => {
    server = new SmppServer<unknown>({
      authenticate: ({ system_id, password }) => system_id === SYSTEM_ID && password === PASSWORD,
      handlers: {
        submit_sm: (pdu: PduOf<'submit_sm'>, session) => {
          const content = decodeMessageContent(pdu as Parameters<typeof decodeMessageContent>[0]);
          const messageId = `K${nextId++}`;
          const entry: Submitted = {
            messageId,
            text: content.text ?? '',
            total: content.concat?.total ?? 1,
            sequence: content.concat?.sequence ?? 1,
            dataCoding: pdu.data_coding,
          };
          if (content.concat) entry.reference = content.concat.reference;
          submitted.push(entry);
          if (pdu.registered_delivery & 0x03) {
            setTimeout(() => {
              session
                .deliverReceipt({
                  messageId,
                  status: 'DELIVERED',
                  source: pdu.destination_addr,
                  destination: pdu.source_addr,
                })
                .catch(() => {});
            }, 100);
          }
          return { message_id: messageId };
        },
      },
    });
    server.on('bind', (s) => {
      binds.push(`${s.systemId}:${s.mode}`);
      sessions.push(s);
    });
    server.on('sessionClose', (s) => {
      if (s.mode !== undefined) closed.push(s.systemId ?? '');
      sessions = sessions.filter((x) => x !== s);
    });

    web = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      hits.push({ path: url.pathname, query: url.searchParams });
      res.end(''); // empty body: smsbox sends no reply SMS
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));

    ports = {
      smpp: (await server.listen(0, '127.0.0.1')).port,
      web: (web.address() as net.AddressInfo).port,
      admin: await freePort(),
      smsbox: await freePort(),
      sendsms: await freePort(),
    };

    writeFileSync(
      join(dir, 'kannel.conf'),
      `group = core
admin-port = ${ports.admin}
admin-password = admin
admin-interface = 127.0.0.1
smsbox-port = ${ports.smsbox}
box-allow-ip = 127.0.0.1
log-file = "${join(dir, 'bearerbox.log')}"
log-level = 0
dlr-storage = internal

group = smsc
smsc = smpp
smsc-id = smppts
host = 127.0.0.1
port = ${ports.smpp}
transceiver-mode = true
smsc-username = ${SYSTEM_ID}
smsc-password = ${PASSWORD}
system-type = ""
interface-version = 34
enquire-link-interval = 30
reconnect-delay = 1

group = smsbox
bearerbox-host = 127.0.0.1
bearerbox-port = ${ports.smsbox}
sendsms-port = ${ports.sendsms}
sendsms-interface = 127.0.0.1
log-file = "${join(dir, 'smsbox.log')}"
log-level = 0

group = sendsms-user
username = tester
password = tester
max-messages = 5
concatenation = true

group = sms-service
keyword = default
catch-all = true
max-messages = 0
get-url = "http://127.0.0.1:${ports.web}/mo?from=%p&to=%P&text=%a"
`,
    );

    const run = (name: string) => {
      const child = spawn(join(BIN, name), [join(dir, 'kannel.conf')], { stdio: 'ignore' });
      processes.push(child);
      return child;
    };
    run('bearerbox');
    await waitUntil(() => binds.length > 0, 20_000, 'the Kannel bind').catch((err) => {
      logs();
      throw err;
    });
    run('smsbox');
    // smsbox is ready once its sendsms port accepts connections.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.connect(ports.sendsms, '127.0.0.1', () => {
          s.destroy();
          resolve(true);
        });
        s.on('error', () => resolve(false));
      });
      if (ok) break;
      if (Date.now() > deadline) {
        logs();
        throw new Error('smsbox did not start');
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);

  afterAll(async () => {
    for (const p of processes) if (p.exitCode === null) p.kill('SIGKILL');
    await server?.close();
    await new Promise((r) => web?.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  async function sendsms(params: Record<string, string>): Promise<{ status: number; body: string }> {
    const query = new URLSearchParams({ username: 'tester', password: 'tester', ...params });
    const res = await fetch(`http://127.0.0.1:${ports.sendsms}/cgi-bin/sendsms?${query}`);
    return { status: res.status, body: await res.text() };
  }

  const dlrUrl = (tag: string) => `http://127.0.0.1:${ports.web}/dlr?tag=${tag}&type=%d&id=%F`;

  it('binds as transceiver with the configured credentials', () => {
    expect(binds).toEqual([`${SYSTEM_ID}:transceiver`]);
  });

  it('short GSM7 message: submit_sm, then the receipt reaches dlr-url', async () => {
    const r = await sendsms({
      from: 'KANNEL',
      to: '2250700000000',
      text: SHORT,
      'dlr-mask': '1',
      'dlr-url': dlrUrl('short'),
    });
    expect(r.status).toBe(202);
    await waitUntil(() => submitted.some((s) => s.text === SHORT), 15_000, 'the short submit_sm');
    const sub = submitted.find((s) => s.text === SHORT)!;
    expect(sub.dataCoding).toBe(0);
    await waitUntil(
      () => hits.some((h) => h.path === '/dlr' && h.query.get('tag') === 'short'),
      15_000,
      'the short receipt',
    ).catch((err) => {
      logs();
      throw err;
    });
    const dlr = hits.find((h) => h.path === '/dlr' && h.query.get('tag') === 'short')!;
    expect(dlr.query.get('type')).toBe('1'); // 1 = delivered
    expect(dlr.query.get('id')).toBe(sub.messageId);
  });

  it('long UCS2 message: concatenated segments reassemble, receipts are matched', async () => {
    const before = submitted.length;
    const r = await sendsms({
      from: 'KANNEL',
      to: '2250700000001',
      text: LONG,
      coding: '2',
      charset: 'UTF-8',
      'dlr-mask': '1',
      'dlr-url': dlrUrl('long'),
    });
    expect(r.status).toBe(202);
    await waitUntil(
      () => {
        const parts = submitted.slice(before);
        return parts.length > 0 && parts.length === parts[0]!.total;
      },
      15_000,
      'every long segment',
    );
    const parts = submitted.slice(before).sort((a, b) => a.sequence - b.sequence);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(parts.map((p) => p.reference)).size).toBe(1);
    expect(parts.every((p) => p.dataCoding === 8)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe(LONG);
    await waitUntil(
      () => hits.some((h) => h.path === '/dlr' && h.query.get('tag') === 'long'),
      15_000,
      'the long receipt',
    );
    const ids = new Set(parts.map((p) => p.messageId));
    for (const h of hits.filter((x) => x.path === '/dlr' && x.query.get('tag') === 'long')) {
      expect(h.query.get('type')).toBe('1');
      expect(ids.has(h.query.get('id') ?? '')).toBe(true);
    }
  });

  it('MO: a deliver_sm from smpp-ts reaches the get-url of the sms-service', async () => {
    const session = sessions[0]!;
    await session.deliver({
      source_addr: '2250700000002',
      destination_addr: '1234',
      short_message: Buffer.from(MO, 'latin1'),
    });
    await waitUntil(() => hits.some((h) => h.path === '/mo'), 15_000, 'the MO on get-url').catch((err) => {
      logs();
      throw err;
    });
    const mo = hits.find((h) => h.path === '/mo')!;
    expect(mo.query.get('text')).toBe(MO);
    expect(mo.query.get('from')).toBe('2250700000002');
    expect(mo.query.get('to')).toBe('1234');
  });

  it('Kannel shutdown unbinds cleanly', async () => {
    const res = await fetch(`http://127.0.0.1:${ports.admin}/cgi-bin/shutdown?password=admin`);
    expect(res.status).toBe(200);
    await waitUntil(() => closed.length > 0, 20_000, 'the session close');
    expect(closed).toEqual([SYSTEM_ID]);
  });
});
