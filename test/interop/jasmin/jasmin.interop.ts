// Compatibility suite against Jasmin (https://github.com/jookies/jasmin), a real SMS gateway.
//
//   smpp-ts SmppClient ──▶ Jasmin SMPP server ──▶ Jasmin connector ──▶ UpstreamSmsc (smpp-ts SmppServer)
//
// Requires the stack of test/interop/jasmin/docker-compose.yml. Skipped unless JASMIN=1.
// See test/interop/jasmin/README.md.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_STATUS,
  type DeliveryReport,
  type InboundMessage,
  type MessageStatus,
  SmppClient,
  type SmppClientOptions,
  SmppConnectionClosedError,
  SmppStatusError,
  buildUdh,
  encodeGsm7,
} from '../../../src/index.js';
import {
  ACCOUNTS,
  CONNECTORS,
  OUTSIDE_FILTER,
  PREFIX,
  TcpCutter,
  UpstreamSmsc,
  dest,
  env,
  provisionJasmin,
  stopConnectors,
} from './harness.js';

const enabled = process.env.JASMIN === '1';
const FROM = 'SMPPTS';
/** Jasmin's own message ids are UUIDs, whatever the upstream SMSC returned. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let upstream: UpstreamSmsc;
const clients: SmppClient[] = [];

afterEach(async () => {
  while (clients.length)
    await clients
      .pop()!
      .close()
      .catch(() => {});
});

function makeClient(options: Partial<SmppClientOptions> = {}): SmppClient {
  const client = new SmppClient({
    host: env.smppHost,
    port: env.smppPort,
    bind: { mode: 'transceiver', ...ACCOUNTS.main },
    reconnect: false,
    retry: false,
    ...options,
  });
  clients.push(client);
  return client;
}

async function waitFor<T>(
  pred: () => T | undefined | false,
  timeoutMs = 20_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!enabled)('Jasmin compatibility', () => {
  beforeAll(async () => {
    upstream = new UpstreamSmsc();
    await upstream.listen();
    await provisionJasmin();
    await upstream.waitFor(
      () => CONNECTORS.every((c) => upstream.bound(c.username)),
      30_000,
      'Jasmin connectors bound upstream',
    );
    // Warm-up: one message through each route, resent until it reaches the upstream SMSC, so a
    // Jasmin start-up hiccup is not reported as an incompatibility of the first test.
    const warm = makeClient();
    await warm.connect();
    for (const prefix of [PREFIX.delivered, PREFIX.hexIds]) {
      await upstream.waitFor(
        async () => {
          const to = dest(prefix);
          await warm.sendText({ to, from: FROM, text: 'warm-up' });
          await new Promise((r) => setTimeout(r, 1_500));
          return upstream.acceptedFor(to).length > 0;
        },
        30_000,
        `warm-up through ${prefix}`,
      );
    }
    await warm.close();
    clients.length = 0;
  }, 120_000);

  afterAll(async () => {
    await stopConnectors().catch(() => {});
    await upstream?.close();
  });

  // ------------------------------------------------------------------ binds

  describe('binds', () => {
    it.each([
      ['transmitter', 'BOUND_TX'],
      ['receiver', 'BOUND_RX'],
      ['transceiver', 'BOUND_TRX'],
    ] as const)('binds as %s, answers enquire_link and unbinds', async (mode, state) => {
      const client = makeClient({ bind: { mode, ...ACCOUNTS.main } });
      await client.connect();
      expect(client.state).toBe(state);
      expect((await client.raw.enquire_link()).command_status).toBe(0);
      await client.close();
      expect(client.state).toBe('CLOSED');
    });

    // Jasmin answers ESME_RINVPASWD (not ESME_RBINDFAIL) and does not reveal whether the
    // system_id exists: the same status for an unknown account.
    it.each([
      ['a wrong password', 'smppts', 'wrong'],
      ['an unknown system_id', 'nobody', 'secret'],
    ] as const)('rejects %s with ESME_RINVPASWD', async (_label, system_id, password) => {
      const client = makeClient({ bind: { mode: 'transceiver', system_id, password } });
      const err = await client.connect().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SmppStatusError);
      expect((err as SmppStatusError).status).toBe(COMMAND_STATUS.ESME_RINVPASWD);
      expect(client.state).toBe('CLOSED');
    });

    it('refuses submit_sm locally on a receiver bind (SEC-07)', async () => {
      const client = makeClient({ bind: { mode: 'receiver', ...ACCOUNTS.main } });
      await client.connect();
      await expect(client.sendText({ to: dest(PREFIX.delivered), from: FROM, text: 'x' })).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------------ submit_sm and encodings

  describe('submit_sm and encodings', () => {
    it.each([
      ['GSM7', 'Hello from smpp-ts', 'GSM7'],
      ['GSM7 extension table', 'Price: 10€ [promo] {x} ~^|\\', 'GSM7'],
      ['UCS2 (emoji, surrogate pairs)', 'Votre code est 123456 🎉', 'UCS2'],
      ['UCS2 (Arabic)', 'رمز التحقق 4821', 'UCS2'],
      ['Latin-1', 'Café à Abidjan: ñ ü ø', undefined],
    ])('%s reaches the upstream SMSC unchanged', async (_label, text, encoding) => {
      const client = makeClient();
      await client.connect();
      const to = dest(PREFIX.delivered);
      const result = await client.sendText({ to, from: FROM, text });
      if (encoding) expect(result.encoding).toBe(encoding);
      expect(result.parts).toBe(1);
      expect(result.messageIds[0]).toMatch(UUID);
      await upstream.waitFor(() => upstream.acceptedFor(to).length === 1, 20_000, `submit to ${to}`);
      expect(upstream.textsFor(to)).toEqual([text]);
    });

    it('Turkish national shift table (UDH IE 0x24) reaches the upstream SMSC', async () => {
      const client = makeClient({ multipart: { shiftTables: ['tr'] } });
      await client.connect();
      const to = dest(PREFIX.delivered);
      const text = 'Doğrulama kodunuz: 4821. İyi günler, Şükrü!';
      const result = await client.sendText({ to, from: FROM, text });
      expect(result.encoding).toBe('GSM7');
      await upstream.waitFor(
        () => upstream.acceptedFor(to).length === result.parts,
        20_000,
        `submit to ${to}`,
      );
      expect(upstream.textsFor(to)).toEqual([text]);
    });

    it('a submit_sm without registered_delivery gets a submit_sm_resp with a Jasmin id', async () => {
      const client = makeClient({ bind: { mode: 'transmitter', ...ACCOUNTS.main } });
      await client.connect();
      const to = dest(PREFIX.delivered);
      const resp = await client.submit({
        source_addr: FROM,
        destination_addr: to,
        short_message: encodeGsm7('raw submit'),
      });
      expect(resp.message_id).toMatch(UUID);
      const [received] = await upstream.waitFor(() => {
        const r = upstream.acceptedFor(to);
        return r.length ? r : undefined;
      });
      // Jasmin assigns its own id: the ESME never sees the upstream one.
      expect(received?.messageId).not.toBe(resp.message_id);
    });
  });

  // ------------------------------------------------------------------ long messages

  describe('long messages and concatenation', () => {
    const longGsm = 'Long message through Jasmin, GSM7 alphabet. '.repeat(8);
    const longUcs2 = 'Message long à travers Jasmin 🎉 émoji. '.repeat(6);

    it.each(['udh8', 'udh16', 'sar'] as const)(
      'GSM7 split with %s is reassembled upstream',
      async (strategy) => {
        const client = makeClient();
        await client.connect();
        const to = dest(PREFIX.delivered);
        const result = await client.sendText({ to, from: FROM, text: longGsm, strategy });
        expect(result.parts).toBeGreaterThan(1);
        expect(new Set(result.messageIds).size).toBe(result.parts);
        for (const id of result.messageIds) expect(id).toMatch(UUID);
        await upstream.waitFor(
          () => upstream.acceptedFor(to).length >= result.parts,
          20_000,
          `parts to ${to}`,
        );
        expect(upstream.textsFor(to)).toEqual([longGsm]);
      },
    );

    it('UCS2 split with udh8 keeps surrogate pairs whole', async () => {
      const client = makeClient();
      await client.connect();
      const to = dest(PREFIX.delivered);
      const result = await client.sendText({ to, from: FROM, text: longUcs2 });
      expect(result.encoding).toBe('UCS2');
      expect(result.parts).toBeGreaterThan(1);
      await upstream.waitFor(() => upstream.acceptedFor(to).length >= result.parts, 20_000, `parts to ${to}`);
      expect(upstream.textsFor(to)).toEqual([longUcs2]);
    });

    // Known Jasmin 0.11 limitation: the connector fails to re-encode a submit_sm carrying
    // message_payload ("Value … size N does not match expected 1") and drops it after the ESME
    // already received its submit_sm_resp. With Jasmin, keep the default udh8 strategy.
    // If this test starts failing, Jasmin fixed it: turn it into a positive check.
    it('message_payload: accepted by Jasmin but never relayed upstream (known Jasmin limitation)', async () => {
      const client = makeClient();
      await client.connect();
      const to = dest(PREFIX.delivered);
      const result = await client.sendText({ to, from: FROM, text: longGsm, strategy: 'payload' });
      expect(result.parts).toBe(1);
      expect(result.messageIds[0]).toMatch(UUID);
      await new Promise((r) => setTimeout(r, 5_000));
      expect(upstream.acceptedFor(to)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ delivery receipts

  describe('delivery receipts', () => {
    it.each([
      ['DELIVERED', PREFIX.delivered, 'DELIVERED'],
      ['UNDELIVERABLE', PREFIX.undeliverable, 'FAILED'],
      ['EXPIRED', PREFIX.expired, 'FAILED'],
    ] as const)(
      'upstream %s receipt reaches the ESME with the Jasmin id',
      async (status, prefix, outcome) => {
        const client = makeClient({ trackDeliveries: true });
        const reports: DeliveryReport[] = [];
        client.on('deliveryReport', (d) => reports.push(d));
        const done = new Promise<MessageStatus>((resolve) => client.on('messageStatus', resolve));
        await client.connect();
        const to = dest(prefix);
        const result = await client.sendText({
          to,
          from: FROM,
          text: `receipt ${status}`,
          registeredDelivery: true,
        });
        const final = await done;
        expect(final.messageIds).toEqual(result.messageIds);
        expect(final.outcome).toBe(outcome);
        expect(reports[0]?.messageId).toBe(result.messageIds[0]);
        expect(reports[0]?.status).toBe(status);
      },
    );

    it('receipts of every part of a long message are aggregated', async () => {
      const client = makeClient({ trackDeliveries: true });
      const done = new Promise<MessageStatus>((resolve) => client.on('messageStatus', resolve));
      await client.connect();
      const to = dest(PREFIX.delivered);
      const result = await client.sendText({
        to,
        from: FROM,
        text: 'Multipart receipt through Jasmin. '.repeat(8),
        registeredDelivery: true,
      });
      expect(result.parts).toBeGreaterThan(1);
      const final = await done;
      expect(final.outcome).toBe('DELIVERED');
      expect(final.reports.every((r) => r?.status === 'DELIVERED')).toBe(true);
    });

    it('a receiver bind of the same account gets the receipts of a transmitter bind', async () => {
      const rx = makeClient({ bind: { mode: 'receiver', ...ACCOUNTS.main } });
      const reports: DeliveryReport[] = [];
      rx.on('deliveryReport', (d) => reports.push(d));
      await rx.connect();
      const tx = makeClient({ bind: { mode: 'transmitter', ...ACCOUNTS.main } });
      await tx.connect();
      const result = await tx.sendText({
        to: dest(PREFIX.delivered),
        from: FROM,
        text: 'rx',
        registeredDelivery: true,
      });
      await waitFor(() => reports.find((r) => r.messageId === result.messageIds[0]), 20_000, 'receipt on rx');
    });
  });

  // ------------------------------------------------------------------ message id formats

  describe('message id differences between SMSCs', () => {
    it('hex id in submit_sm_resp, decimal in the receipt (dlr_msgid 1): Jasmin maps it back', async () => {
      const client = makeClient({ trackDeliveries: true });
      const done = new Promise<MessageStatus>((resolve) => client.on('messageStatus', resolve));
      await client.connect();
      const to = dest(PREFIX.hexIds);
      const result = await client.sendText({ to, from: FROM, text: 'hex ids', registeredDelivery: true });
      const [received] = await upstream.waitFor(() => {
        const r = upstream.acceptedFor(to);
        return r.length ? r : undefined;
      });
      expect(received?.connector).toBe('jasminhx');
      expect(received?.messageId).toMatch(/^[0-9a-f]+$/);
      const final = await done;
      expect(final.outcome).toBe('DELIVERED');
      expect(final.reports[0]?.messageId).toBe(result.messageIds[0]);
    });

    it('the receipt text follows the usual id:… stat:… format', async () => {
      const client = makeClient();
      const pdus: string[] = [];
      client.on('deliveryReport', (_d, pdu) =>
        pdus.push('short_message' in pdu ? (pdu.short_message?.toString('latin1') ?? '') : ''),
      );
      await client.connect();
      const result = await client.sendText({
        to: dest(PREFIX.delivered),
        from: FROM,
        text: 'fmt',
        registeredDelivery: true,
      });
      const text = await waitFor(() => pdus[0], 20_000, 'receipt');
      expect(text).toMatch(new RegExp(`^id:${result.messageIds[0]} `));
      expect(text).toMatch(/stat:DELIVRD/);
    });
  });

  // ------------------------------------------------------------------ MO

  describe('mobile-originated messages (deliver_sm)', () => {
    it('a short MO from the upstream SMSC reaches the ESME', async () => {
      const client = makeClient({ bind: { mode: 'receiver', ...ACCOUNTS.main } });
      const messages: InboundMessage[] = [];
      client.on('message', (m) => messages.push(m));
      await client.connect();
      await upstream.server.deliver('jasmin', {
        source_addr: '2250700000999',
        destination_addr: '1234',
        short_message: encodeGsm7('STOP promo'),
      });
      const msg = await waitFor(() => messages.find((m) => m.from === '2250700000999'), 20_000, 'MO');
      expect(msg.text).toBe('STOP promo');
    });

    it('a concatenated MO (UDH 8-bit) is reassembled by the client', async () => {
      const client = makeClient();
      const messages: InboundMessage[] = [];
      client.on('message', (m) => messages.push(m));
      await client.connect();
      const parts = ['Première partie, ', 'deuxième partie.'];
      for (const [i, part] of parts.entries()) {
        const udh = buildUdh([{ iei: 0x00, data: Buffer.from([0x42, parts.length, i + 1]) }]);
        await upstream.server.deliver('jasmin', {
          source_addr: '2250700000998',
          destination_addr: '1234',
          esm_class: 0x40,
          data_coding: 0x08,
          short_message: Buffer.concat([udh, Buffer.from(part, 'utf16le').swap16()]),
        });
      }
      const msg = await waitFor(() => messages.find((m) => m.from === '2250700000998'), 20_000, 'long MO');
      expect(msg.parts).toBe(2);
      expect(msg.text).toBe(parts.join(''));
    });
  });

  // ------------------------------------------------------------------ errors and throttling

  describe('errors and throttling', () => {
    it('a destination outside the account filter is refused with ESME_RINVDSTADR', async () => {
      const client = makeClient({ bind: { mode: 'transmitter', ...ACCOUNTS.filtered } });
      await client.connect();
      const err = await client
        .sendText({ to: OUTSIDE_FILTER, from: FROM, text: 'x' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SmppStatusError);
      expect((err as SmppStatusError).status).toBe(COMMAND_STATUS.ESME_RINVDSTADR);
      // The same account can still send inside its filter.
      await client.sendText({ to: dest(PREFIX.delivered), from: FROM, text: 'ok' });
    });

    it('over the account throughput, Jasmin answers ESME_RTHROTTLED', async () => {
      const client = makeClient({ bind: { mode: 'transmitter', ...ACCOUNTS.slow } });
      await client.connect();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          client.sendText({ to: dest(PREFIX.delivered), from: FROM, text: 'burst' }),
        ),
      );
      const throttled = results.filter(
        (r) =>
          r.status === 'rejected' && (r.reason as SmppStatusError).status === COMMAND_STATUS.ESME_RTHROTTLED,
      );
      expect(throttled.length).toBeGreaterThan(0);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('with retry enabled, every throttled message ends up accepted', async () => {
      const client = makeClient({
        bind: { mode: 'transmitter', ...ACCOUNTS.slow },
        retry: { maxRetries: 10, initialDelay: 300, maxDelay: 1_500 },
      });
      const throttles: string[] = [];
      client.on('metric', (m) => {
        if (m.name === 'command_status' && m.labels.status === 'ESME_RTHROTTLED')
          throttles.push(m.labels.command);
      });
      await client.connect();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          client.sendText({ to: dest(PREFIX.delivered), from: FROM, text: 'retry' }),
        ),
      );
      expect(results).toHaveLength(4);
      expect(throttles.length).toBeGreaterThan(0);
    }, 30_000);

    it('ESME_RTHROTTLED from the upstream SMSC is retried by Jasmin, invisible to the ESME', async () => {
      const client = makeClient({ trackDeliveries: true });
      const done = new Promise<MessageStatus>((resolve) => client.on('messageStatus', resolve));
      await client.connect();
      const to = dest(PREFIX.throttledUpstream);
      const result = await client.sendText({
        to,
        from: FROM,
        text: 'upstream throttled',
        registeredDelivery: true,
      });
      expect(result.messageIds[0]).toMatch(UUID);
      const final = await done;
      expect(final.outcome).toBe('DELIVERED');
      const attempts = upstream.submits.filter((s) => s.pdu.destination_addr === to);
      // Jasmin retries every 30 s by default (`submit_error_retrial` in jasmin.cfg).
      expect(attempts.map((a) => a.status)).toEqual([
        COMMAND_STATUS.ESME_RTHROTTLED,
        COMMAND_STATUS.ESME_RTHROTTLED,
        0,
      ]);
    }, 120_000);
  });

  // ------------------------------------------------------------------ network cuts

  describe('network cuts and reconnection', () => {
    it('client ↔ Jasmin cut: in-flight requests rejected, automatic reconnect and re-bind', async () => {
      const cutter = new TcpCutter(env.smppHost, env.smppPort);
      const port = await cutter.listen();
      try {
        const client = makeClient({
          port,
          reconnect: { initialDelay: 200, maxDelay: 1_000 },
          requestTimeout: 15_000,
        });
        const events: string[] = [];
        client.on('reconnecting', () => events.push('reconnecting'));
        client.on('reconnected', () => events.push('reconnected'));
        await client.connect();

        // Many sends in flight, then cut: the ones not answered yet are rejected, never left hanging.
        const inflight = Array.from({ length: 20 }, () =>
          client.sendText({ to: dest(PREFIX.delivered), from: FROM, text: 'in flight' }).then(
            () => 'ok',
            (e: unknown) => e,
          ),
        );
        await new Promise((r) => setImmediate(r));
        expect(cutter.cut()).toBeGreaterThan(0);
        const outcomes = await Promise.all(inflight);
        for (const o of outcomes) if (o !== 'ok') expect(o).toBeInstanceOf(SmppConnectionClosedError);

        await waitFor(
          () => client.state === 'BOUND_TRX' && events.includes('reconnected'),
          20_000,
          'reconnect',
        );
        const after = await client.sendText({
          to: dest(PREFIX.delivered),
          from: FROM,
          text: 'after the cut',
        });
        expect(after.messageIds[0]).toMatch(UUID);
      } finally {
        await cutter.close();
      }
    }, 40_000);

    it('Jasmin ↔ upstream cut: Jasmin reconnects its connector and delivers the queued message', async () => {
      const client = makeClient();
      await client.connect();
      upstream.refuseBinds = true;
      upstream.dropConnections();
      await upstream.waitFor(() => !upstream.bound('jasmin'), 10_000, 'connector down');
      const to = dest(PREFIX.delivered);
      // Jasmin accepts and queues while its upstream is down.
      const result = await client.sendText({ to, from: FROM, text: 'queued during the cut' });
      expect(result.messageIds[0]).toMatch(UUID);
      upstream.refuseBinds = false;
      await upstream.waitFor(() => upstream.bound('jasmin'), 30_000, 'connector back');
      await upstream.waitFor(
        () => upstream.acceptedFor(to).length === 1,
        180_000,
        'queued message delivered',
      );
      expect(upstream.textsFor(to)).toEqual(['queued during the cut']);
    }, 240_000);
  });
});
