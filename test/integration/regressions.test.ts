/**
 * Non-régression des bugs de session (§3) contre un faux SMSC piloté à la main.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMANDS,
  COMMAND_STATUS,
  SmppClient,
  type SmppClientOptions,
  SmppConnectionClosedError,
  SmppTimeoutError,
} from '../../src/index.js';
import { type RawSmsc, createRawSmsc, defaultBehaviour, sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function smsc(onPdu?: Parameters<typeof createRawSmsc>[0]): Promise<RawSmsc> {
  const s = await createRawSmsc(onPdu);
  cleanups.push(() => s.close());
  return s;
}

function client(port: number, options: Partial<SmppClientOptions> = {}) {
  const c = new SmppClient({
    host: '127.0.0.1',
    port,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: false,
    retry: false,
    ...options,
  });
  cleanups.push(() => c.close());
  return c;
}

describe('BUG-01: every request has a timeout', () => {
  it('rejects with SmppTimeoutError and frees the window slot', async () => {
    const s = await smsc(); // ne répond jamais à submit_sm
    const c = client(s.port, { requestTimeout: 100, window: 1 });
    await c.connect();
    const t0 = Date.now();
    const err = await c.submit({ destination_addr: '1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppTimeoutError);
    expect((err as SmppTimeoutError).written).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.inflight).toBe(0);
    // La fenêtre est libérée : une nouvelle requête peut partir.
    const second = c.submit({ destination_addr: '2' }).catch((e: unknown) => e);
    await until(() => s.connections[0]!.received.filter((p) => p.command === 'submit_sm').length === 2);
    expect(await second).toBeInstanceOf(SmppTimeoutError);
  });

  it('no request stays pending longer than requestTimeout, even when queued (§14)', async () => {
    const s = await smsc();
    const c = client(s.port, { requestTimeout: 150, window: 1 });
    await c.connect();
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        c.submit({ destination_addr: '1' }).then(
          () => 'ok',
          (e: Error) => e,
        ),
      ),
    );
    const elapsed = Date.now() - t0;
    expect(results.every((r) => r instanceof SmppTimeoutError)).toBe(true);
    expect(elapsed).toBeLessThan(150 + 100);
    // Les requêtes restées en file n'ont jamais été écrites.
    expect(results.filter((r) => (r as SmppTimeoutError).written === false)).toHaveLength(4);
    expect(c.queueSize).toBe(0);
  });

  it('ignores late responses after a timeout', async () => {
    const s = await smsc((pdu, conn) => {
      defaultBehaviour(pdu, conn);
      if (pdu.command === 'submit_sm') {
        setTimeout(
          () =>
            conn.send({
              command: 'submit_sm_resp',
              sequence_number: pdu.sequence_number,
              message_id: 'late',
            }),
          80,
        );
      }
    });
    const c = client(s.port, { requestTimeout: 30 });
    await c.connect();
    await expect(c.submit({ destination_addr: '1' })).rejects.toBeInstanceOf(SmppTimeoutError);
    await sleep(120);
    expect(c.state).toBe('BOUND_TRX');
  });
});

describe('BUG-02: pending requests are rejected on close', () => {
  it('rejects in-flight (written) and queued (not written) requests', async () => {
    const s = await smsc((pdu, conn) => {
      defaultBehaviour(pdu, conn);
      if (pdu.command === 'submit_sm') conn.socket.destroy();
    });
    const c = client(s.port, { window: 1 });
    await c.connect();
    const [a, b] = await Promise.all([
      c.submit({ destination_addr: '1' }).catch((e: unknown) => e),
      c.submit({ destination_addr: '2' }).catch((e: unknown) => e),
    ]);
    expect(a).toBeInstanceOf(SmppConnectionClosedError);
    expect((a as SmppConnectionClosedError).written).toBe(true);
    expect(b).toBeInstanceOf(SmppConnectionClosedError);
    expect((b as SmppConnectionClosedError).written).toBe(false);
  });
});

describe('BUG-03: reconnection does not silently drop pending requests', () => {
  it('rejects in-flight requests before re-binding, then works again', async () => {
    let drop = true;
    const s = await smsc((pdu, conn) => {
      defaultBehaviour(pdu, conn);
      if (pdu.command === 'submit_sm') {
        if (drop) {
          drop = false;
          conn.socket.destroy();
        } else {
          conn.send({ command: 'submit_sm_resp', sequence_number: pdu.sequence_number, message_id: 'after' });
        }
      }
    });
    const c = client(s.port, { reconnect: { initialDelay: 10, maxDelay: 20 } });
    await c.connect();
    const err = await c.submit({ destination_addr: '1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppConnectionClosedError);
    expect((err as SmppConnectionClosedError).written).toBe(true);
    // Pas de renvoi automatique d'un message peut-être accepté (pas de doublon).
    const res = await c.submit({ destination_addr: '2' });
    expect(res.message_id).toBe('after');
    expect(s.connections).toHaveLength(2);
    expect(s.connections[1]!.received.filter((p) => p.command === 'submit_sm')).toHaveLength(1);
  });
});

describe('BUG-07: enquire_link without response is detected', () => {
  it('declares the session dead and reconnects', async () => {
    const s = await smsc((pdu, conn) => {
      if (pdu.command !== 'enquire_link') defaultBehaviour(pdu, conn); // ignore les enquire_link
    });
    const c = client(s.port, {
      enquireLinkInterval: 40,
      enquireLinkTimeout: 40,
      reconnect: { initialDelay: 10, maxDelay: 20 },
    });
    const errors: string[] = [];
    c.on('error', (e) => errors.push(e.code));
    let reconnecting = false;
    c.on('reconnecting', () => {
      reconnecting = true;
    });
    await c.connect();
    await until(() => reconnecting, 2000);
    expect(errors).toContain('SMPP_TIMEOUT');
    await until(() => s.connections.length >= 2, 2000);
  });

  it('keeps the session alive when enquire_link is answered', async () => {
    const s = await smsc();
    const c = client(s.port, { enquireLinkInterval: 30, enquireLinkTimeout: 30 });
    await c.connect();
    await sleep(200);
    expect(c.state).toBe('BOUND_TRX');
    expect(s.connections[0]!.received.filter((p) => p.command === 'enquire_link').length).toBeGreaterThan(1);
  });
});

describe('BUG-08: a parsing error does not stop the session', () => {
  it('nacks an unknown command with ESME_RINVCMDID and keeps working', async () => {
    const s = await smsc((pdu, conn) => {
      defaultBehaviour(pdu, conn);
      if (pdu.command === 'submit_sm')
        conn.send({ command: 'submit_sm_resp', sequence_number: pdu.sequence_number, message_id: 'ok' });
    });
    const c = client(s.port);
    await c.connect();
    const conn = s.connections[0]!;
    const unknown = Buffer.alloc(16);
    unknown.writeUInt32BE(16, 0);
    unknown.writeUInt32BE(0x00000777, 4);
    unknown.writeUInt32BE(99, 12);
    conn.sendRaw(unknown);
    const { pdu } = await s.waitFor((p) => p.command === 'generic_nack');
    expect(pdu).toMatchObject({ sequence_number: 99, command_status: COMMAND_STATUS.ESME_RINVCMDID });
    expect((await c.submit({ destination_addr: '1' })).message_id).toBe('ok');
  });

  it('nacks a malformed deliver_sm body with the decode status and keeps working', async () => {
    const s = await smsc();
    const c = client(s.port);
    const delivered: unknown[] = [];
    c.on('deliver', (p) => delivered.push(p));
    await c.connect();
    const conn = s.connections[0]!;
    // deliver_sm dont le service_type n'est jamais terminé.
    const bad = Buffer.concat([Buffer.alloc(16), Buffer.from('ABCDEFGHIJ', 'latin1')]);
    bad.writeUInt32BE(bad.length, 0);
    bad.writeUInt32BE(COMMANDS.deliver_sm.id, 4);
    bad.writeUInt32BE(7, 12);
    conn.sendRaw(bad);
    const { pdu } = await s.waitFor((p) => p.command === 'generic_nack');
    expect(pdu.sequence_number).toBe(7);
    expect(pdu.command_status).not.toBe(0);
    // La session continue : un deliver_sm valide est traité.
    conn.send({
      command: 'deliver_sm',
      sequence_number: 8,
      source_addr: '1',
      destination_addr: '2',
      short_message: Buffer.from('hi'),
    });
    await s.waitFor((p) => p.command === 'deliver_sm_resp' && p.sequence_number === 8);
    expect(delivered).toHaveLength(1);
    expect(c.state).toBe('BOUND_TRX');
  });

  it('closes the session only when the stream is desynchronized', async () => {
    const s = await smsc();
    const c = client(s.port);
    c.on('error', () => {});
    await c.connect();
    s.connections[0]!.sendRaw(Buffer.from([0, 0, 0, 5, 1, 2, 3, 4]));
    await until(() => c.state === 'CLOSED');
  });

  it('answers ESME_RINVBNDSTS to deliver_sm on a transmitter session', async () => {
    const s = await smsc();
    const c = client(s.port, { bind: { mode: 'transmitter', system_id: 'a', password: 'b' } });
    await c.connect();
    s.connections[0]!.send({ command: 'deliver_sm', sequence_number: 3, short_message: Buffer.from('x') });
    const { pdu } = await s.waitFor((p) => p.command === 'deliver_sm_resp');
    expect(pdu.command_status).toBe(COMMAND_STATUS.ESME_RINVBNDSTS);
  });

  it('rejects the pending request when its response cannot be decoded', async () => {
    const s = await smsc((pdu, conn) => {
      defaultBehaviour(pdu, conn);
      if (pdu.command === 'submit_sm') {
        const bad = Buffer.concat([Buffer.alloc(16), Buffer.from('X'.repeat(70), 'latin1')]);
        bad.writeUInt32BE(bad.length, 0);
        bad.writeUInt32BE(COMMANDS.submit_sm_resp.id, 4);
        bad.writeUInt32BE(pdu.sequence_number, 12);
        conn.sendRaw(bad);
      }
    });
    const c = client(s.port);
    await c.connect();
    await expect(c.submit({ destination_addr: '1' })).rejects.toMatchObject({ name: 'SmppDecodeError' });
    expect(c.state).toBe('BOUND_TRX');
  });
});

describe('unbind handling', () => {
  it('responds to a server-initiated unbind and closes', async () => {
    const s = await smsc();
    const c = client(s.port);
    await c.connect();
    s.connections[0]!.send({ command: 'unbind', sequence_number: 50 });
    const { pdu } = await s.waitFor((p) => p.command === 'unbind_resp');
    expect(pdu.sequence_number).toBe(50);
    await until(() => c.state === 'CLOSED');
  });

  it('forces the socket closed when unbind_resp never comes', async () => {
    const s = await smsc((pdu, conn) => {
      if (pdu.command !== 'unbind') defaultBehaviour(pdu, conn);
    });
    const c = client(s.port, { unbindTimeout: 50 });
    await c.connect();
    const t0 = Date.now();
    await c.close();
    expect(c.state).toBe('CLOSED');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('sequence numbers', () => {
  it('wraps around at 0x7FFFFFFF', async () => {
    const s = await smsc((pdu, conn) => {
      defaultBehaviour(pdu, conn);
      if (pdu.command === 'submit_sm')
        conn.send({
          command: 'submit_sm_resp',
          sequence_number: pdu.sequence_number,
          message_id: String(pdu.sequence_number),
        });
    });
    const c = client(s.port);
    await c.connect();
    const session = (c as unknown as { session: { sequence: number } }).session;
    session.sequence = 0x7ffffffe;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await c.submit({ destination_addr: '1' })).message_id);
    expect(ids).toEqual([String(0x7fffffff), '1', '2']);
  });
});
