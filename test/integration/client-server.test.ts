import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_STATUS,
  type DeliveryReport,
  type InboundMessage,
  type MessageStatus,
  SmppClient,
  type SmppClientOptions,
  SmppServer,
  type SmppServerOptions,
  SmppStateError,
  SmppStatusError,
  safeCompare,
} from '../../src/index.js';
import type { Logger } from '../../src/logger.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

let idCounter = 0;

async function startServer(options: Partial<SmppServerOptions<{ account: string }>> = {}) {
  const server = new SmppServer<{ account: string }>({
    authenticate: ({ system_id, password }) =>
      system_id === 'acme' && safeCompare(password, 'secret') ? { account: system_id } : false,
    handlers: {
      submit_sm: () => ({ message_id: `MSG${++idCounter}` }),
    },
    ...options,
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { server, port };
}

function makeClient(port: number, options: Partial<SmppClientOptions> = {}) {
  const client = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: { initialDelay: 20, maxDelay: 100 },
    ...options,
  });
  cleanups.push(() => client.close());
  return client;
}

describe('client ↔ server', () => {
  it('binds, sends a text and closes cleanly', async () => {
    const { server, port } = await startServer();
    const bound: string[] = [];
    server.on('bind', (s) => bound.push(`${s.systemId}:${s.mode}:${s.context?.account}`));
    const client = makeClient(port);
    const states: string[] = [];
    client.on('stateChange', (_, to) => states.push(to));
    await client.connect();
    expect(client.state).toBe('BOUND_TRX');
    expect(bound).toEqual(['acme:transceiver:acme']);

    const res = await client.sendText({
      to: '+2250700000000',
      from: 'MISSOU',
      text: 'Votre code est 123456 🎉',
      registeredDelivery: true,
    });
    expect(res).toMatchObject({ parts: 1, encoding: 'UCS2' });
    expect(res.messageIds).toHaveLength(1);

    await client.close({ drain: true });
    expect(states).toEqual(['OPEN', 'BOUND_TRX', 'UNBOUND', 'CLOSED']);
    await until(() => server.sessions.size === 0);
  });

  it('sends multipart messages with distinct ids and correct UDH', async () => {
    const received: Buffer[] = [];
    const { port } = await startServer({
      handlers: {
        submit_sm: (pdu) => {
          received.push(pdu.short_message);
          return { message_id: `P${received.length}` };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    const res = await client.sendText({ to: '2250700000000', from: 'MISSOU', text: 'a'.repeat(400) });
    expect(res.parts).toBe(3);
    expect(res.encoding).toBe('GSM7');
    expect(new Set(res.messageIds).size).toBe(3);
    const refs = received.map((b) => b[3]);
    expect(new Set(refs).size).toBe(1);
    expect(received.map((b) => b[5]).sort()).toEqual([1, 2, 3]);
  });

  it('uses TON/NPI defaults according to the address format', async () => {
    let captured: Record<string, unknown> = {};
    const { port } = await startServer({
      handlers: {
        submit_sm: (pdu) => {
          captured = { ...pdu };
          return { message_id: '1' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    await client.sendText({ to: '+2250700000000', from: 'MISSOU', text: 'x' });
    expect(captured).toMatchObject({
      source_addr_ton: 5,
      source_addr_npi: 0,
      dest_addr_ton: 1,
      dest_addr_npi: 1,
      destination_addr: '2250700000000',
    });
    await client.sendText({ to: '0700000000', from: '1234', text: 'x' });
    expect(captured).toMatchObject({ source_addr_ton: 0, source_addr_npi: 1, dest_addr_ton: 0 });
    await expect(client.sendText({ to: 'ABC', from: '1', text: 'x' })).rejects.toThrow(/phone number/);
  });

  it('receives delivery reports and MO messages (reassembled)', async () => {
    const { server, port } = await startServer();
    const client = makeClient(port);
    const reports: DeliveryReport[] = [];
    const messages: InboundMessage[] = [];
    client.on('deliveryReport', (d) => reports.push(d));
    client.on('message', (m) => messages.push(m));
    await client.connect();
    await until(() => server.sessions.size === 1 && [...server.sessions][0]!.canDeliver);
    const ss = [...server.sessions][0]!;

    await ss.deliverReceipt({
      messageId: 'MSG-9',
      status: 'DELIVERED',
      source: '2250700000000',
      destination: 'MISSOU',
    });
    await until(() => reports.length === 1);
    expect(reports[0]).toMatchObject({ messageId: 'MSG-9', status: 'DELIVERED', source: '2250700000000' });

    // MO en deux segments UDH, envoyés dans le désordre
    const udh = (seq: number) => Buffer.from([5, 0, 3, 42, 2, seq]);
    await server.deliver('acme', {
      source_addr: '2250700000000',
      destination_addr: '1234',
      esm_class: 0x40,
      short_message: Buffer.concat([udh(2), Buffer.from(' monde', 'latin1')]),
    });
    await server.deliver('acme', {
      source_addr: '2250700000000',
      destination_addr: '1234',
      esm_class: 0x40,
      short_message: Buffer.concat([udh(1), Buffer.from('Bonjour', 'latin1')]),
    });
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ text: 'Bonjour monde', parts: 2, from: '2250700000000', to: '1234' });
  });

  it('rejects a bad password with ESME_RBINDFAIL and identical behaviour for unknown accounts', async () => {
    const { server, port } = await startServer();
    const failures: string[] = [];
    server.on('bindFailed', (i) => failures.push(i.system_id));
    const bad = makeClient(port, {
      bind: { mode: 'transceiver', system_id: 'acme', password: 'wrong' },
      reconnect: false,
    });
    const err1 = await bad.connect().catch((e: unknown) => e);
    const unknown = makeClient(port, {
      bind: { mode: 'transceiver', system_id: 'ghost', password: 'x' },
      reconnect: false,
    });
    const err2 = await unknown.connect().catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(SmppStatusError);
    expect(err2).toBeInstanceOf(SmppStatusError);
    expect((err1 as SmppStatusError).status).toBe(COMMAND_STATUS.ESME_RBINDFAIL);
    expect((err2 as SmppStatusError).status).toBe((err1 as SmppStatusError).status);
    expect(failures).toEqual(['acme', 'ghost']);
  });

  it('bans an IP after repeated bind failures (SEC-05)', async () => {
    const { server, port } = await startServer({ bindFailures: { maxAttempts: 2, banMs: 60_000 } });
    const rejected: string[] = [];
    server.on('rejected', (r) => rejected.push(r.reason));
    for (let i = 0; i < 2; i++) {
      const c = makeClient(port, {
        bind: { mode: 'transceiver', system_id: 'acme', password: 'nope' },
        reconnect: false,
      });
      await c.connect().catch(() => {});
    }
    const good = makeClient(port, { reconnect: false });
    await expect(good.connect()).rejects.toThrow();
    expect(rejected[0]).toMatch(/banned/);
  });

  it('refuses submit_sm locally in receiver mode (SEC-07, client side)', async () => {
    const { port } = await startServer();
    const client = makeClient(port, { bind: { mode: 'receiver', system_id: 'acme', password: 'secret' } });
    await client.connect();
    const err = await client
      .submit({ destination_addr: '1', short_message: Buffer.from('x') })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppStateError);
    expect((err as SmppStateError).status).toBe(COMMAND_STATUS.ESME_RINVBNDSTS);
  });

  it('refuses deliver_sm to a transmitter session (SEC-07, server side)', async () => {
    const { server, port } = await startServer();
    const client = makeClient(port, { bind: { mode: 'transmitter', system_id: 'acme', password: 'secret' } });
    await client.connect();
    await expect(server.deliver('acme', { short_message: Buffer.from('x') })).rejects.toBeInstanceOf(
      SmppStateError,
    );
  });

  it('server answers ESME_RINVBNDSTS to PDUs sent before bind (SEC-06)', async () => {
    const { port } = await startServer();
    const net = await import('node:net');
    const { encodePdu, decodePdu } = await import('../../src/codec/pdu.js');
    const sock = net.connect(port, '127.0.0.1');
    cleanups.push(async () => sock.destroy());
    await new Promise((r) => sock.once('connect', r));
    sock.write(encodePdu({ command: 'submit_sm', sequence_number: 5, short_message: Buffer.from('x') }));
    const data: Buffer = await new Promise((r) => sock.once('data', r));
    const resp = decodePdu(data);
    expect(resp).toMatchObject({
      command: 'submit_sm_resp',
      sequence_number: 5,
      command_status: COMMAND_STATUS.ESME_RINVBNDSTS,
    });
  });

  it('server closes sessions that never bind (bindTimeout)', async () => {
    const { server, port } = await startServer({ bindTimeout: 50 });
    const net = await import('node:net');
    const sock = net.connect(port, '127.0.0.1');
    cleanups.push(async () => sock.destroy());
    await new Promise((r) => sock.once('close', r));
    await until(() => server.sessions.size === 0);
  });

  it('enforces maxSessionsPerSystemId', async () => {
    const { port } = await startServer({ maxSessionsPerSystemId: 1 });
    await makeClient(port).connect();
    const second = makeClient(port, { reconnect: false });
    await expect(second.connect()).rejects.toBeInstanceOf(SmppStatusError);
  });

  it('auto-replies ESME_RSYSERR when a handler throws and handler status when provided', async () => {
    const { port } = await startServer({
      handlers: {
        submit_sm: (pdu) => {
          if (pdu.destination_addr === '1') throw new Error('boom');
          if (pdu.destination_addr === '2')
            throw new SmppStatusError('submit_sm', COMMAND_STATUS.ESME_RINVDSTADR);
          return COMMAND_STATUS.ESME_RINVSRCADR;
        },
      },
    });
    const client = makeClient(port, { retry: false });
    await client.connect();
    const status = (dest: string) =>
      client.submit({ destination_addr: dest }).then(
        () => 0,
        (e: SmppStatusError) => e.status,
      );
    expect(await status('1')).toBe(COMMAND_STATUS.ESME_RSYSERR);
    expect(await status('2')).toBe(COMMAND_STATUS.ESME_RINVDSTADR);
    expect(await status('3')).toBe(COMMAND_STATUS.ESME_RINVSRCADR);
  });

  it('auto-replies ESME_RSYSERR when a handler hangs (handlerTimeout)', async () => {
    const { port } = await startServer({
      handlerTimeout: 50,
      handlers: { submit_sm: () => new Promise(() => {}) },
    });
    const client = makeClient(port, { retry: false });
    await client.connect();
    await expect(client.submit({ destination_addr: '1' })).rejects.toMatchObject({
      status: COMMAND_STATUS.ESME_RSYSERR,
    });
  });

  it('answers ESME_RINVCMDID for commands without handler', async () => {
    const { port } = await startServer();
    const client = makeClient(port);
    await client.connect();
    await expect(client.query('X')).rejects.toMatchObject({ status: COMMAND_STATUS.ESME_RINVCMDID });
  });

  it('retries temporary errors (ESME_RTHROTTLED) with backoff', async () => {
    let calls = 0;
    const { port } = await startServer({
      handlers: { submit_sm: () => (++calls < 3 ? COMMAND_STATUS.ESME_RTHROTTLED : { message_id: 'ok' }) },
    });
    const client = makeClient(port, { retry: { maxRetries: 3, initialDelay: 5, maxDelay: 10 } });
    await client.connect();
    const res = await client.submit({ destination_addr: '1' });
    expect(res.message_id).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry permanent errors', async () => {
    let calls = 0;
    const { port } = await startServer({
      handlers: {
        submit_sm: () => {
          calls++;
          return COMMAND_STATUS.ESME_RINVDSTADR;
        },
      },
    });
    const client = makeClient(port, { retry: { maxRetries: 3, initialDelay: 5 } });
    await client.connect();
    await expect(client.submit({ destination_addr: '1' })).rejects.toBeInstanceOf(SmppStatusError);
    expect(calls).toBe(1);
  });

  it('respects the send window (REL-03)', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const { port } = await startServer({
      handlers: {
        submit_sm: async () => {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          await sleep(10);
          inflight--;
          return { message_id: 'x' };
        },
      },
    });
    const client = makeClient(port, { window: 3 });
    await client.connect();
    await Promise.all(Array.from({ length: 20 }, () => client.submit({ destination_addr: '1' })));
    expect(maxInflight).toBe(3);
  });

  it('rejects with SmppQueueFullError when the queue is full', async () => {
    const { port } = await startServer({
      handlers: { submit_sm: () => new Promise(() => {}) },
      handlerTimeout: 60_000,
    });
    const client = makeClient(port, { window: 1, maxQueueSize: 2, requestTimeout: 500 });
    await client.connect();
    const ps = Array.from({ length: 4 }, () =>
      client.submit({ destination_addr: '1' }).catch((e: Error) => e.name),
    );
    const results = await Promise.all(ps);
    expect(results.filter((r) => r === 'SmppQueueFullError')).toHaveLength(1);
    expect(results.filter((r) => r === 'SmppTimeoutError')).toHaveLength(3);
  });

  it('applies the rate limit (REL-04)', async () => {
    const { port } = await startServer();
    const client = makeClient(port, { rateLimit: { perSecond: 50, burst: 1 } });
    await client.connect();
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => client.submit({ destination_addr: '1' })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('reconnects and re-binds after the connection drops; queued messages are sent (REL-05)', async () => {
    const { server, port } = await startServer();
    const client = makeClient(port);
    const events: string[] = [];
    client.on('reconnecting', (a) => events.push(`reconnecting:${a}`));
    client.on('reconnected', () => events.push('reconnected'));
    await client.connect();
    for (const s of server.sessions) s.destroy();
    await until(() => client.state === 'CLOSED');
    // Envoyé pendant la coupure : reste en file puis part après le re-bind.
    const pending = client.submit({ destination_addr: '1' });
    const res = await pending;
    expect(res.message_id).toMatch(/^MSG/);
    expect(events[0]).toBe('reconnecting:1');
    expect(events).toContain('reconnected');
    expect(client.state).toBe('BOUND_TRX');
  });

  it('emits reconnectFailed after maxAttempts and rejects queued messages', async () => {
    const { server, port } = await startServer();
    const client = makeClient(port, { reconnect: { initialDelay: 5, maxDelay: 10, maxAttempts: 2 } });
    await client.connect();
    let failed = false;
    client.on('reconnectFailed', () => {
      failed = true;
    });
    await server.close();
    await until(() => client.state === 'CLOSED');
    const p = client.submit({ destination_addr: '1' }).catch((e: Error) => e);
    await until(() => failed);
    expect(await p).toMatchObject({ name: 'SmppConnectionClosedError', written: false });
  });

  it('drains in-flight requests on close({ drain: true }) (REL-07)', async () => {
    const { port } = await startServer({
      handlers: {
        submit_sm: async () => {
          await sleep(50);
          return { message_id: 'late' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    const p = client.submit({ destination_addr: '1' });
    await sleep(5);
    const closing = client.close({ drain: true });
    await expect(client.submit({ destination_addr: '2' })).rejects.toBeInstanceOf(SmppStateError);
    expect((await p).message_id).toBe('late');
    await closing;
    expect(client.state).toBe('CLOSED');
  });

  it('exposes raw commands and generic request()', async () => {
    const { port } = await startServer({
      handlers: { query_sm: (pdu) => ({ message_id: pdu.message_id, message_state: 2, final_date: '' }) },
    });
    const client = makeClient(port);
    await client.connect();
    const q = await client.raw.query_sm({ message_id: 'M1' });
    expect(q).toMatchObject({ command: 'query_sm_resp', message_id: 'M1', message_state: 2 });
    const e = await client.request('enquire_link');
    expect(e.command).toBe('enquire_link_resp');
  });

  it('never logs the password (SEC-02, §14)', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (m, meta) => lines.push(`${m} ${JSON.stringify(meta)}`),
      info: (m, meta) => lines.push(`${m} ${JSON.stringify(meta)}`),
      warn: (m, meta) => lines.push(`${m} ${JSON.stringify(meta)}`),
      error: (m, meta) => lines.push(`${m} ${JSON.stringify(meta)}`),
    };
    const { port } = await startServer({ logger });
    const client = makeClient(port, { logger });
    await client.connect();
    await client.sendText({ to: '1', from: 'A', text: 'x' });
    const bad = makeClient(port, {
      logger,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'wrongpw' },
      reconnect: false,
    });
    await bad.connect().catch(() => {});
    await client.close();
    const all = lines.join('\n');
    expect(all).toContain('bind_transceiver');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('wrongpw');
  });

  it('emits metrics', async () => {
    const { port } = await startServer();
    const client = makeClient(port);
    const names = new Set<string>();
    client.on('metric', (m) => names.add(m.name));
    await client.connect();
    await client.submit({ destination_addr: '1' });
    for (const n of [
      'pdu.sent',
      'pdu.received',
      'request.latency',
      'bytes.in',
      'bytes.out',
      'request.inflight',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('does not crash when no error listener is attached (§8.3)', async () => {
    const errors: string[] = [];
    const logger: Logger = { debug() {}, info() {}, warn() {}, error: (m) => errors.push(m) };
    const client = new SmppClient({
      host: '127.0.0.1',
      port: 1,
      bind: { mode: 'transceiver', system_id: 'a', password: 'b' },
      logger,
    });
    // Appel direct du chemin d'émission d'erreur : doit journaliser et non lever.
    (client as unknown as { emitError(e: Error & { code: string }): void }).emitError(
      Object.assign(new Error('unheard'), { code: 'X' }),
    );
    expect(errors).toEqual(['unheard']);
  });
});

describe('sendText addressing and delivery tracking', () => {
  it('rejects an invalid sender before anything is sent', async () => {
    let submits = 0;
    const { port } = await startServer({
      handlers: {
        submit_sm: () => {
          submits++;
          return { message_id: 'X' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    await expect(
      client.sendText({ to: '+2250700000000', from: 'MonEntrepriseCI', text: 'x' }),
    ).rejects.toThrow(/max 11/);
    await client.sendText({ to: '00225 07 00 00 00 00', from: 'MISSOU', text: 'x' });
    expect(submits).toBe(1);
  });

  it('aggregates per-segment receipts into one messageStatus', async () => {
    const { server, port } = await startServer();
    const client = makeClient(port, { trackDeliveries: true });
    const statuses: MessageStatus[] = [];
    client.on('messageStatus', (s) => statuses.push(s));
    await client.connect();
    await until(() => server.sessions.size === 1 && [...server.sessions][0]!.canDeliver);
    const ss = [...server.sessions][0]!;

    const result = await client.sendText({
      to: '+2250700000000',
      from: 'MISSOU',
      text: 'a'.repeat(400),
      registeredDelivery: true,
      reference: 'order-42',
    });
    expect(result.parts).toBe(3);
    expect(client.trackedMessages).toBe(1);

    for (const [i, messageId] of result.messageIds.entries()) {
      await ss.deliverReceipt({
        messageId,
        status: i === 2 ? 'UNDELIVERABLE' : 'DELIVERED',
        source: '2250700000000',
        destination: 'MISSOU',
      });
    }
    await until(() => statuses.length === 1);
    expect(statuses[0]).toMatchObject({
      outcome: 'PARTIALLY_DELIVERED',
      reference: 'order-42',
      messageIds: result.messageIds,
    });
    expect(client.trackedMessages).toBe(0);
  });

  it('does not track without trackDeliveries or without a final receipt request', async () => {
    const { port } = await startServer();
    const plain = makeClient(port);
    await plain.connect();
    await plain.sendText({ to: '+2250700000000', from: 'MISSOU', text: 'x', registeredDelivery: true });
    expect(plain.trackedMessages).toBe(0);

    const tracking = makeClient(port, { trackDeliveries: { ttl: 1000 } });
    await tracking.connect();
    await tracking.sendText({ to: '+2250700000000', from: 'MISSOU', text: 'x', registeredDelivery: 0x02 });
    expect(tracking.trackedMessages).toBe(0);
    await tracking.sendText({ to: '+2250700000000', from: 'MISSOU', text: 'x', registeredDelivery: true });
    expect(tracking.trackedMessages).toBe(1);
  });
});
