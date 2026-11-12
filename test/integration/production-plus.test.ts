import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_STATUS,
  type DeliveryReport,
  type InboundMessage,
  type MessageStatus,
  SmppClient,
  type SmppClientOptions,
  SmppConnectionClosedError,
  SmppPool,
  SmppStatusError,
  SmppTimeoutError,
} from '../../src/index.js';
import { type TestSmsc, type TestSmscOptions, createTestSmsc } from '../../src/testing/index.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function smsc(options: TestSmscOptions = {}): Promise<TestSmsc> {
  const s = await createTestSmsc(options);
  cleanups.push(() => s.close());
  return s;
}

async function client(s: TestSmsc, options: Partial<SmppClientOptions> = {}): Promise<SmppClient> {
  const c = new SmppClient({
    url: s.url,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: { initialDelay: 20, maxDelay: 50 },
    retry: { initialDelay: 10, maxDelay: 20 },
    ...options,
  });
  cleanups.push(() => c.close());
  await c.connect();
  return c;
}

const LONG_FR =
  'Bonjour, votre colis arrive aujourd’hui entre 14h et 16h. Merci de votre confiance et à bientôt sur notre boutique !';

describe('GSM7 normalization in sendText', () => {
  it('sends a normalized text in GSM7 when it saves segments', async () => {
    const s = await smsc();
    const c = await client(s, { normalize: 'transliterate' });
    const r = await c.sendText({ from: 'ACME', to: '2250700000000', text: LONG_FR });
    expect(r).toMatchObject({ parts: 1, encoding: 'GSM7', replacements: 2 });
    expect(s.submitted[0]?.pdu.data_coding).toBe(0);
    expect(s.submitted[0]?.text).toContain("aujourd'hui");
    expect(s.submitted[0]?.text).toContain('bientot');
  });

  it('per-message override and estimate()', async () => {
    const s = await smsc();
    const c = await client(s);
    expect(c.estimate({ text: LONG_FR })).toMatchObject({
      encoding: 'ucs2',
      segments: 2,
      suggestion: { normalize: 'transliterate', segments: 1 },
    });
    const plain = await c.sendText({ from: 'ACME', to: '2250700000000', text: LONG_FR });
    expect(plain).toMatchObject({ parts: 2, encoding: 'UCS2', replacements: 0 });
    const n = await c.sendText({
      from: 'ACME',
      to: '2250700000000',
      text: LONG_FR,
      normalize: 'transliterate',
    });
    expect(n).toMatchObject({ parts: 1, encoding: 'GSM7' });
  });
});

describe('priority queue', () => {
  it('an urgent message overtakes queued bulk traffic', async () => {
    const s = await smsc();
    const c = await client(s, { window: 1 });
    s.delayNext('submit_sm', 100);
    const sends = ['bulk 1', 'bulk 2', 'bulk 3', 'bulk 4'].map((text) =>
      c.sendText({ from: 'ACME', to: '2250700000000', text }),
    );
    await until(() => c.queueSize === 3);
    expect(c.health().queuedByPriority).toEqual([3, 0, 0, 0]);
    const otp = c.sendText({ from: 'ACME', to: '2250700000000', text: 'OTP 123456', priority: 3 });
    await Promise.all([...sends, otp]);
    expect(s.submitted.map((m) => m.text)).toEqual(['bulk 1', 'OTP 123456', 'bulk 2', 'bulk 3', 'bulk 4']);
    expect((s.submitted[1]?.pdu as { priority_flag?: number }).priority_flag).toBe(3);
  });

  it('submit() takes its queue priority from priority_flag', async () => {
    const s = await smsc();
    const c = await client(s, { window: 1 });
    s.delayNext('submit_sm', 80);
    const p = [
      c.submit({ destination_addr: '1', short_message: Buffer.from('a') }),
      c.submit({ destination_addr: '2', short_message: Buffer.from('b') }),
      c.submit({ destination_addr: '3', short_message: Buffer.from('c'), priority_flag: 2 }),
    ];
    await Promise.all(p);
    expect(s.submitted.map((m) => m.to)).toEqual(['1', '3', '2']);
  });
});

describe('inbound deduplication', () => {
  it('drops a receipt sent twice: one deliveryReport, one messageStatus', async () => {
    const s = await smsc({ duplicateReceipts: true });
    const c = await client(s, { trackDeliveries: true });
    const reports: DeliveryReport[] = [];
    const statuses: MessageStatus[] = [];
    const dups: string[] = [];
    c.on('deliveryReport', (d) => reports.push(d));
    c.on('messageStatus', (st) => statuses.push(st));
    c.on('duplicate', (kind) => dups.push(kind));
    await c.sendText({ from: 'ACME', to: '2250700000000', text: 'hi', registeredDelivery: true });
    await until(() => dups.length === 1);
    await sleep(30);
    expect(reports).toHaveLength(1);
    expect(statuses).toHaveLength(1);
    expect(dups).toEqual(['receipt']);
  });

  it('dedup: false keeps every copy', async () => {
    const s = await smsc({ duplicateReceipts: true });
    const c = await client(s, { dedup: false });
    const reports: DeliveryReport[] = [];
    c.on('deliveryReport', (d) => reports.push(d));
    await c.sendText({ from: 'ACME', to: '2250700000000', text: 'hi', registeredDelivery: true });
    await until(() => reports.length === 2);
  });

  it('drops a repeated incoming message when messages: true (multipart included)', async () => {
    const s = await smsc();
    const c = await client(s, { dedup: { messages: true } });
    const messages: InboundMessage[] = [];
    const dups: string[] = [];
    c.on('message', (m) => messages.push(m));
    c.on('duplicate', (kind) => dups.push(kind));
    const long = 'x'.repeat(200);
    await s.sendMo({ from: '2250700000000', to: '1234', text: 'STOP' });
    await s.sendMo({ from: '2250700000000', to: '1234', text: 'STOP' });
    await s.sendMo({ from: '2250700000000', to: '1234', text: long });
    await until(() => messages.length === 2);
    expect(messages.map((m) => m.text)).toEqual(['STOP', long]);
    expect(dups).toEqual(['message']);
  });

  it('a pool deduplicates across its binds', async () => {
    const s = await smsc();
    const pool = new SmppPool({
      url: s.url,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
      size: 2,
      minBound: 2,
    });
    cleanups.push(() => pool.close());
    await pool.connect();
    const reports: DeliveryReport[] = [];
    const dups: string[] = [];
    pool.on('deliveryReport', (d) => reports.push(d));
    pool.on('duplicate', (k) => dups.push(k));
    const [a, b] = s.sessions;
    const receipt = { messageId: '42', status: 'DELIVERED' as const, source: '225', destination: 'ACME' };
    await a!.deliverReceipt(receipt);
    await b!.deliverReceipt(receipt);
    await until(() => dups.length === 1);
    expect(reports).toHaveLength(1);
  });
});

describe('health, updateBind and rebind', () => {
  it('health() reports state, load and traffic', async () => {
    const s = await smsc();
    const before = Date.now();
    const c = await client(s, { rateLimit: { perSecond: 100 } });
    const h = c.health();
    expect(h).toMatchObject({
      healthy: true,
      state: 'BOUND_TRX',
      reconnecting: false,
      reconnectAttempt: 0,
      inflight: 0,
      queued: 0,
      queuedByPriority: [0, 0, 0, 0],
      rateLimit: 100,
      trackedMessages: 0,
    });
    expect(h.boundAt).toBeGreaterThanOrEqual(before);
    expect(h.lastReceivedAt).toBeGreaterThanOrEqual(before);

    s.disconnectAll();
    await until(() => c.health().reconnecting || c.isBound === false);
    expect(c.health().healthy).toBe(false);
    await until(() => c.isBound);
    expect(c.health().healthy).toBe(true);
  });

  it('rotates the password with a graceful rebind: nothing in flight is lost', async () => {
    const passwords: string[] = [];
    const s = await smsc({
      authenticate: ({ password }) => {
        passwords.push(password);
        return password === 'old' || password === 'new';
      },
    });
    const c = await client(s, { bind: { mode: 'transceiver', system_id: 'acme', password: 'old' } });
    c.updateBind({ password: 'new' });
    expect(passwords).toEqual(['old']); // applies at the next bind only

    s.delayNext('submit_sm', 100);
    const inflight = c.sendText({ from: 'ACME', to: '2250700000000', text: 'in flight' });
    await until(() => c.inflight === 1);
    const rebound = c.rebind();
    const queued = c.sendText({ from: 'ACME', to: '2250700000000', text: 'during rebind' });
    await rebound;
    await expect(inflight).resolves.toMatchObject({ parts: 1 });
    await expect(queued).resolves.toMatchObject({ parts: 1 });
    expect(passwords).toEqual(['old', 'new']);
    expect(s.binds).toHaveLength(2);
    expect(c.isBound).toBe(true);
  });

  it('a failed rebind rejects, then reconnection takes over', async () => {
    let accept = 'secret';
    const s = await smsc({ authenticate: ({ password }) => password === accept });
    const c = await client(s);
    c.updateBind({ password: 'rotated' });
    await expect(c.rebind()).rejects.toBeInstanceOf(SmppStatusError);
    accept = 'rotated';
    await until(() => c.isBound);
  });

  it('updateBind refuses an empty system_id', async () => {
    const s = await smsc();
    const c = await client(s);
    expect(() => c.updateBind({ system_id: '' })).toThrow(/system_id/);
  });

  it('pool: rolling rebind keeps at least one bind up', async () => {
    const s = await smsc();
    const pool = new SmppPool({
      url: s.url,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
      size: 2,
      minBound: 2,
    });
    cleanups.push(() => pool.close());
    await pool.connect();
    let minBound = 2;
    pool.on('memberDown', () => {
      minBound = Math.min(minBound, pool.boundCount);
    });
    pool.updateBind({ password: 'secret2' });
    await pool.rebind();
    expect(minBound).toBe(1);
    expect(s.binds).toHaveLength(4);
    expect(pool.health()).toMatchObject({ healthy: true, bound: 2, size: 2 });
    expect(pool.health().members).toHaveLength(2);
    expect(pool.estimate({ text: 'hello' }).segments).toBe(1);
  });
});

describe('congestion_state (SMPP 5.0)', () => {
  it('slows the rate limiter down when the SMSC nears congestion', async () => {
    const s = await smsc();
    const c = await client(s, { rateLimit: { perSecond: 100 } });
    const metrics: number[] = [];
    c.on('metric', (m) => {
      if (m.name === 'session.congestion') metrics.push(m.value);
    });
    s.setCongestion(50);
    await c.sendText({ from: 'ACME', to: '1', text: 'a' });
    expect(c.health()).toMatchObject({ congestionState: 50, rateLimit: 100 });
    s.setCongestion(95);
    await c.sendText({ from: 'ACME', to: '1', text: 'b' });
    expect(c.health().congestionState).toBe(95);
    expect(c.health().rateLimit).toBe(50);
    expect(metrics).toEqual([50, 95]);
  });

  it('congestionThreshold: 0 disables the slowdown', async () => {
    const s = await smsc();
    const c = await client(s, { rateLimit: { perSecond: 100 }, congestionThreshold: 0 });
    s.setCongestion(100);
    await c.sendText({ from: 'ACME', to: '1', text: 'a' });
    expect(c.health().rateLimit).toBe(100);
  });
});

describe('TestSmsc fault injection', () => {
  it('records submits and binds, and waits for requests', async () => {
    const s = await smsc();
    const c = await client(s);
    const waiting = s.waitFor('submit_sm', { count: 2 });
    await c.sendText({ from: 'ACME', to: '2250700000000', text: 'one' });
    await c.sendText({ from: 'ACME', to: '2250700000000', text: 'two' });
    expect(await waiting).toHaveLength(2);
    expect(s.submitted.map((m) => [m.text, m.messageId, m.systemId])).toEqual([
      ['one', '1', 'acme'],
      ['two', '2', 'acme'],
    ]);
    expect(s.binds).toEqual([{ systemId: 'acme', mode: 'transceiver', sessionId: expect.any(String) }]);
    await expect(s.waitFor('cancel_sm', { timeout: 30 })).rejects.toThrow(/0 of 1 cancel_sm/);
    s.reset();
    expect(s.submitted).toHaveLength(0);
  });

  it('throttleNext: the client retries and succeeds', async () => {
    const s = await smsc();
    const c = await client(s);
    s.throttleNext(1);
    await expect(c.sendText({ from: 'ACME', to: '1', text: 'x' })).resolves.toMatchObject({
      messageIds: ['1'],
    });
    expect(s.received.filter((p) => p.command === 'submit_sm')).toHaveLength(2);
  });

  it('failNext answers a permanent error', async () => {
    const s = await smsc();
    const c = await client(s);
    s.failNext('submit_sm', COMMAND_STATUS.ESME_RINVDSTADR);
    await expect(c.sendText({ from: 'ACME', to: '1', text: 'x' })).rejects.toMatchObject({
      status: COMMAND_STATUS.ESME_RINVDSTADR,
    });
  });

  it('dropNext: the request times out, written', async () => {
    const s = await smsc();
    const c = await client(s, { requestTimeout: 100 });
    s.dropNext('submit_sm');
    const err = await c.sendText({ from: 'ACME', to: '1', text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppTimeoutError);
    expect((err as SmppTimeoutError).written).toBe(true);
  });

  it('disconnectOnNext: the connection drops with the request in flight', async () => {
    const s = await smsc();
    const c = await client(s);
    s.disconnectOnNext('submit_sm');
    const err = await c.sendText({ from: 'ACME', to: '1', text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppConnectionClosedError);
    expect((err as SmppConnectionClosedError).written).toBe(true);
    await until(() => c.isBound);
  });

  it('sendMo and sendReceipt reach the client; receipts policy by function', async () => {
    const s = await smsc({ receipts: (pdu) => (pdu.destination_addr === '999' ? 'UNDELIVERABLE' : 'none') });
    const c = await client(s);
    const reports: DeliveryReport[] = [];
    const messages: InboundMessage[] = [];
    c.on('deliveryReport', (d) => reports.push(d));
    c.on('message', (m) => messages.push(m));
    await c.sendText({ from: 'ACME', to: '111', text: 'x', registeredDelivery: true });
    await c.sendText({ from: 'ACME', to: '999', text: 'y', registeredDelivery: true });
    await until(() => reports.length === 1);
    expect(reports[0]).toMatchObject({ messageId: '2', status: 'UNDELIVERABLE' });
    await s.sendReceipt({ messageId: '1', status: 'DELIVERED', from: '111', to: 'ACME' });
    await s.sendMo({ from: '2250700000000', to: 'ACME', text: 'Réponse 👍 '.repeat(10) });
    await until(() => reports.length === 2 && messages.length === 1);
    expect(messages[0]?.text).toBe('Réponse 👍 '.repeat(10));
    expect(messages[0]?.parts).toBeGreaterThan(1);
  });

  it('sendMo without a receiver session throws', async () => {
    const s = await smsc();
    await client(s, { bind: { mode: 'transmitter', system_id: 'acme', password: 'secret' } });
    await expect(s.sendMo({ from: '1', to: '2', text: 'x' })).rejects.toThrow(/No receiver/);
  });

  it('answers query_sm, cancel_sm, data_sm and submit_multi', async () => {
    const s = await smsc({ messageId: (n) => `ID${n}` });
    const c = await client(s);
    await expect(c.query('ID1')).resolves.toMatchObject({ message_id: 'ID1', message_state: 2 });
    await expect(c.cancel('ID1')).resolves.toBeDefined();
    await expect(c.raw.data_sm({ destination_addr: '1' })).resolves.toMatchObject({ message_id: 'ID1' });
    await expect(
      c.raw.submit_multi({
        dest_address: [{ dest_flag: 1, dest_addr_ton: 1, dest_addr_npi: 1, destination_addr: '1' }],
      }),
    ).resolves.toMatchObject({ message_id: 'ID2' });
  });
});
