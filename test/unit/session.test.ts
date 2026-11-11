import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodePdu, encodePdu } from '../../src/codec/pdu.js';
import { SmppConnectionClosedError, SmppStateError, SmppValidationError } from '../../src/errors.js';
import type { Metric } from '../../src/metrics.js';
import { COMMAND_STATUS } from '../../src/protocol/status.js';
import { Session } from '../../src/session/session.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Paire de sockets TCP connectées : [côté ESME, côté SMSC]. */
async function socketPair(): Promise<[net.Socket, net.Socket]> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const accepted = new Promise<net.Socket>((r) => server.once('connection', r));
  const client = net.connect(port, '127.0.0.1');
  const peer = await accepted;
  await new Promise((r) => (client.connecting ? client.once('connect', r) : r(undefined)));
  cleanups.push(() => {
    client.destroy();
    peer.destroy();
    server.close();
  });
  return [client, peer];
}

/** Sessions ESME et SMSC reliées et bindées en transceiver. */
async function boundPair(esmeOpts = {}, smscOpts = {}) {
  const [a, b] = await socketPair();
  const esme = new Session(a, { role: 'esme', enquireLinkInterval: 0, ...esmeOpts });
  const smsc = new Session(b, { role: 'smsc', enquireLinkInterval: 0, ...smscOpts });
  smsc.on('pdu', (pdu) => {
    if (pdu.command === 'bind_transceiver') {
      smsc.respond(pdu, { system_id: 'SMSC' });
      smsc.markBound('transceiver', pdu.system_id);
    }
  });
  await esme.bind('transceiver', { system_id: 'acme', password: 'pw' });
  await until(() => smsc.state === 'BOUND_TRX');
  return { esme, smsc, a, b };
}

describe('Session', () => {
  it('exposes the remote address and refuses bind from the SMSC role', async () => {
    const { esme, smsc } = await boundPair();
    expect(esme.remoteAddress).toBe('127.0.0.1');
    await expect(smsc.bind('transceiver', {})).rejects.toBeInstanceOf(SmppStateError);
  });

  it('refuses invalid requests before queueing', async () => {
    const [a] = await socketPair();
    const s = new Session(a, { role: 'esme', enquireLinkInterval: 0 });
    // unbind n'est autorisé qu'une fois bindé
    await expect(s.request('unbind')).rejects.toBeInstanceOf(SmppStateError);
    expect(() => s.send('alert_notification')).toThrow(SmppStateError);
  });

  it('rejects requests without response and responses to such requests', async () => {
    const { smsc } = await boundPair();
    await expect(smsc.request('alert_notification' as never)).rejects.toBeInstanceOf(SmppValidationError);
    expect(() => smsc.respond({ command: 'alert_notification', sequence_number: 1 })).toThrow(
      SmppValidationError,
    );
  });

  it('sends alert_notification without waiting for a response', async () => {
    const { esme, smsc } = await boundPair();
    const got: string[] = [];
    esme.on('pdu', (p) => got.push(p.command));
    smsc.send('alert_notification', { source_addr: '1', esme_addr: '2' });
    await until(() => got.includes('alert_notification'));
  });

  it('answers ESME_RSYSERR when nobody listens to incoming requests', async () => {
    const { esme, smsc } = await boundPair();
    esme.removeAllListeners('pdu');
    smsc.removeAllListeners('pdu');
    await expect(esme.request('submit_sm')).rejects.toMatchObject({ status: COMMAND_STATUS.ESME_RSYSERR });
  });

  it('survives a throwing listener and reports it as an error', async () => {
    const { esme, smsc } = await boundPair();
    const errors: string[] = [];
    smsc.on('error', (e) => errors.push(e.code));
    smsc.on('pdu', (p) => {
      if (p.command === 'submit_sm') throw new Error('listener bug');
    });
    smsc.on('pdu', (p) => {
      if (p.command === 'submit_sm') smsc.respond(p, { message_id: 'x' });
    });
    await expect(esme.request('submit_sm', {}, { timeout: 200 })).rejects.toBeDefined();
    expect(errors).toContain('SMPP_HANDLER');
    expect(smsc.state).toBe('BOUND_TRX');
  });

  it('logs errors when no error listener is attached', async () => {
    const logged: string[] = [];
    const [a] = await socketPair();
    const s = new Session(a, {
      role: 'esme',
      enquireLinkInterval: 0,
      logger: { debug() {}, info() {}, warn() {}, error: (m) => logged.push(m) },
    });
    s.emitError(new SmppStateError('x', 'OPEN'));
    expect(logged).toEqual(['Cannot x in state OPEN']);
  });

  it('rejects mismatched response commands', async () => {
    const { esme, smsc } = await boundPair();
    smsc.removeAllListeners('pdu');
    smsc.on('pdu', (p) => {
      // Répond à un submit_sm par un query_sm_resp portant le même sequence_number.
      smsc.socket.write(encodePdu({ command: 'query_sm_resp', sequence_number: p.sequence_number }));
    });
    await expect(esme.request('submit_sm')).rejects.toThrow(/Expected submit_sm_resp/);
  });

  it('rejects queued requests that the bind mode forbids once bound', async () => {
    const [a, b] = await socketPair();
    const esme = new Session(a, { role: 'esme', enquireLinkInterval: 0 });
    const smsc = new Session(b, { role: 'smsc', enquireLinkInterval: 0 });
    smsc.on('pdu', (p) => {
      if (p.command === 'bind_receiver') {
        smsc.respond(p, {});
        smsc.markBound('receiver');
      }
    });
    // Mis en file avant le bind, puis interdit en mode receiver.
    const queued = esme.request('submit_sm');
    await esme.bind('receiver', {});
    await expect(queued).rejects.toBeInstanceOf(SmppStateError);
  });

  it('penalizes the rate limiter on ESME_RTHROTTLED', async () => {
    const { TokenBucket } = await import('../../src/session/rate-limiter.js');
    const limiter = new TokenBucket({ perSecond: 100 });
    const { esme, smsc } = await boundPair({ rateLimiter: limiter, classifyStatus: () => 'temporary' });
    smsc.on('pdu', (p) => {
      if (p.command === 'submit_sm') smsc.respond(p, { command_status: COMMAND_STATUS.ESME_RTHROTTLED });
    });
    await expect(esme.request('submit_sm')).rejects.toMatchObject({ category: 'temporary' });
    expect(limiter.currentRate).toBe(50);
  });

  it('closes idle sessions (idleTimeout)', async () => {
    const { smsc } = await boundPair({}, { idleTimeout: 50 });
    await until(() => smsc.isClosed, 2000);
  });

  it('rejects its own queue on close with written: false', async () => {
    const { esme, smsc } = await boundPair({ window: 1 });
    smsc.removeAllListeners('pdu');
    smsc.on('pdu', () => {}); // ne répond jamais
    const first = esme.request('submit_sm').catch((e: unknown) => e);
    const second = esme.request('submit_sm').catch((e: unknown) => e);
    await sleep(20);
    esme.destroy();
    expect(await first).toMatchObject({ written: true });
    const err = await second;
    expect(err).toBeInstanceOf(SmppConnectionClosedError);
    expect((err as SmppConnectionClosedError).written).toBe(false);
    await expect(esme.request('submit_sm')).rejects.toBeInstanceOf(SmppConnectionClosedError);
  });

  it('keeps PDU order across pause/resume', async () => {
    const { esme, smsc } = await boundPair();
    const seen: number[] = [];
    smsc.removeAllListeners('pdu');
    smsc.on('pdu', (p) => {
      seen.push(p.sequence_number);
      if (seen.length === 1) {
        smsc.pause();
        setTimeout(() => smsc.resume(), 30);
      }
      smsc.respond(p as never, { message_id: String(p.sequence_number) });
    });
    // Trois PDU dans le même paquet TCP.
    const buf = Buffer.concat(
      [1, 2, 3].map((n) => encodePdu({ command: 'submit_sm', sequence_number: 100 + n })),
    );
    esme.socket.write(buf);
    await until(() => seen.length === 3);
    expect(seen).toEqual([101, 102, 103]);
  });

  it('resumes processing after back-pressure (drain)', async () => {
    const { esme, smsc } = await boundPair({ window: 50 });
    let blocked = 0;
    const write = esme.socket.write.bind(esme.socket);
    // Simule un socket saturé une écriture sur deux.
    (esme.socket as unknown as { write: (b: Buffer) => boolean }).write = (b: Buffer) => {
      write(b);
      if (++blocked % 2 === 0) {
        setTimeout(() => esme.socket.emit('drain'), 5);
        return false;
      }
      return true;
    };
    smsc.on('pdu', (p) => {
      if (p.command === 'submit_sm') smsc.respond(p, { message_id: 'ok' });
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => esme.request('submit_sm')));
    expect(results).toHaveLength(10);
  });

  it('logs a socket error and closes with it as cause', async () => {
    const { esme } = await boundPair();
    const warns: string[] = [];
    (esme as unknown as { logger: { warn: (m: string) => void } }).logger.warn = (m) => warns.push(m);
    const closed = new Promise<Error | undefined>((r) => esme.once('close', r));
    esme.socket.destroy(new Error('ECONNRESET'));
    expect((await closed)?.message).toBe('ECONNRESET');
  });

  it('emits metrics including command_status for error responses', async () => {
    const { esme, smsc } = await boundPair();
    const metrics: Metric[] = [];
    smsc.on('metric', (m) => metrics.push(m));
    smsc.on('pdu', (p) => {
      if (p.command === 'submit_sm') smsc.respond(p, { command_status: COMMAND_STATUS.ESME_RINVDSTADR });
    });
    await esme.request('submit_sm').catch(() => {});
    expect(metrics.some((m) => m.name === 'command_status')).toBe(true);
  });

  it('logs PDUs in debug without the password', async () => {
    const lines: string[] = [];
    const logger = {
      debug: (m: string, meta?: object) => lines.push(`${m} ${JSON.stringify(meta)}`),
      info() {},
      warn() {},
      error() {},
    };
    await boundPair({ logger });
    expect(lines.join('\n')).toContain('bind_transceiver');
    expect(lines.join('\n')).not.toContain('"pw"');
    expect(decodePdu(encodePdu({ command: 'enquire_link' })).command).toBe('enquire_link');
  });
});
