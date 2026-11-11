// Interoperability of the smpp-ts SERVER with third-party SMPP clients.
//
//   SMPP_INTEROP_CLIENT="python3 test/interop/clients/python_smpplib.py" npm run test:interop
//
// The client command receives `<host> <port>` as its last arguments. It must bind as transceiver with the
// credentials of clients/expected.json, send the short and the long text with registered_delivery=1, wait
// for the receipts and for one MO, unbind, and print a JSON summary on its last line:
//   { "submitted": [message ids], "receipts": [message ids], "mo": [texts] }
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type PduOf, SmppServer, decodeMessageContent } from '../../src/index.js';

const command = process.env.SMPP_INTEROP_CLIENT;
const expected = JSON.parse(readFileSync(join(import.meta.dirname, 'clients', 'expected.json'), 'utf8')) as {
  systemId: string;
  password: string;
  short: string;
  long: string;
  mo: string;
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

interface Summary {
  submitted: string[];
  receipts: string[];
  mo: string[];
}

function runClient(port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(`${command} 127.0.0.1 ${port}`, { shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!command)(`smpp-ts server with ${command ?? '(SMPP_INTEROP_CLIENT not set)'}`, () => {
  it('bind, short and long messages, receipts, MO, unbind', { timeout: 90_000 }, async () => {
    let nextId = 1;
    const binds: string[] = [];
    const texts = new Map<string, Array<{ seq: number; total: number; text: string }>>();
    let unbound = false;

    const server = new SmppServer({
      authenticate: ({ system_id, password }) =>
        system_id === expected.systemId && password === expected.password,
      handlers: {
        submit_sm: (pdu: PduOf<'submit_sm'>, session) => {
          const content = decodeMessageContent(pdu as Parameters<typeof decodeMessageContent>[0]);
          const key = content.concat ? `ref-${content.concat.reference}` : `single-${nextId}`;
          const list = texts.get(key) ?? [];
          list.push({
            seq: content.concat?.sequence ?? 1,
            total: content.concat?.total ?? 1,
            text: content.text ?? '',
          });
          texts.set(key, list);
          const messageId = `IOP${nextId++}`;
          if (pdu.registered_delivery & 0x03) {
            setTimeout(() => {
              session
                .deliverReceipt({
                  messageId,
                  status: 'DELIVERED',
                  source: pdu.destination_addr,
                  destination: pdu.source_addr,
                  err: '000',
                })
                .catch(() => {});
            }, 50);
          }
          return { message_id: messageId };
        },
      },
    });
    server.on('bind', (s) => {
      binds.push(`${s.systemId}:${s.mode}`);
      // One MO to the client, as soon as it is bound.
      setTimeout(() => {
        s.deliver({
          source_addr: '2250700000000',
          destination_addr: 'PYTHON',
          short_message: Buffer.from(expected.mo, 'latin1'),
          data_coding: 0x03,
        }).catch(() => {});
      }, 100);
    });
    server.on('sessionClose', (s) => {
      if (s.mode !== undefined) unbound = true;
    });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());

    const result = await runClient(port);
    if (result.code !== 0) console.error(result.stderr || result.stdout);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout.trim().split('\n').pop()!) as Summary;

    // Server side: what the client sent.
    expect(binds).toEqual([`${expected.systemId}:transceiver`]);
    const messages = [...texts.values()].map((parts) => {
      parts.sort((a, b) => a.seq - b.seq);
      expect(parts).toHaveLength(parts[0]!.total);
      return parts.map((p) => p.text).join('');
    });
    expect(messages).toContain(expected.short);
    expect(messages).toContain(expected.long);

    // Client side: what the server sent.
    expect(summary.submitted.length).toBeGreaterThanOrEqual(3); // 1 short + at least 2 long parts
    expect([...summary.receipts].sort()).toEqual([...summary.submitted].sort());
    expect(summary.mo).toContain(expected.mo);
    expect(unbound).toBe(true);
  });
});
