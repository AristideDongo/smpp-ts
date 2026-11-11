// Interoperability against a third-party SMSC: simulator in CI, or an operator's test SMSC.
// Configured through environment variables (see test/interop/README.md).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DeliveryReport,
  type MessageStatus,
  SmppClient,
  type SmppClientOptions,
} from '../../src/index.js';

const env = process.env;
const url = env.SMPP_INTEROP_URL;
const to = env.SMPP_INTEROP_TO ?? '+2250700000000';
const from = env.SMPP_INTEROP_FROM ?? 'SMPPTS';
/** Does the SMSC send receipts? (`0` for an SMSC that sends none in test) */
const expectDlr = env.SMPP_INTEROP_EXPECT_DLR !== '0';
const dlrTimeout = Number(env.SMPP_INTEROP_DLR_TIMEOUT ?? 30_000);

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
    url: url!,
    bind: {
      mode: 'transceiver',
      system_id: env.SMPP_INTEROP_SYSTEM_ID ?? 'smppts',
      password: env.SMPP_INTEROP_PASSWORD ?? 'secret',
      ...(env.SMPP_INTEROP_SYSTEM_TYPE ? { system_type: env.SMPP_INTEROP_SYSTEM_TYPE } : {}),
    },
    reconnect: false,
    // SMSC with a self-signed certificate: provide its CA rather than disabling verification (SEC-01).
    ...(env.SMPP_INTEROP_TLS_CA ? { tls: { ca: readFileSync(env.SMPP_INTEROP_TLS_CA) } } : {}),
    ...options,
  });
  clients.push(client);
  return client;
}

describe.skipIf(!url)(`interop with ${url ?? '(SMPP_INTEROP_URL not set)'}`, () => {
  it('binds as transceiver and unbinds cleanly', async () => {
    const client = makeClient();
    await client.connect();
    expect(client.state).toBe('BOUND_TRX');
    await client.close();
    expect(client.state).toBe('CLOSED');
  });

  it('answers enquire_link', async () => {
    const client = makeClient();
    await client.connect();
    const resp = await client.raw.enquire_link();
    expect(resp.command_status).toBe(0);
  });

  it.each([
    ['GSM7', 'Hello from smpp-ts {interop} €', 'GSM7'],
    ['UCS2', 'Votre code est 123456 🎉', 'UCS2'],
  ])('submits a single %s message', async (_, text, encoding) => {
    const client = makeClient();
    await client.connect();
    const result = await client.sendText({ to, from, text });
    expect(result).toMatchObject({ parts: 1, encoding });
    expect(result.messageIds[0]).toMatch(/\S/);
  });

  it.each(['udh8', 'udh16', 'sar'] as const)('submits a long message with %s', async (strategy) => {
    const client = makeClient();
    await client.connect();
    const result = await client.sendText({ to, from, text: 'smpp-ts interop '.repeat(25), strategy });
    expect(result.parts).toBeGreaterThan(1);
    expect(new Set(result.messageIds).size).toBe(result.parts);
  });

  it('keeps a window of concurrent requests', async () => {
    const client = makeClient({ window: 5 });
    await client.connect();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => client.sendText({ to, from, text: `burst ${i}` })),
    );
    expect(results).toHaveLength(20);
  });

  it.skipIf(!expectDlr)(
    'receives delivery receipts and aggregates them per message',
    async () => {
      const client = makeClient({ trackDeliveries: true });
      const reports: DeliveryReport[] = [];
      client.on('deliveryReport', (d) => reports.push(d));
      const status = new Promise<MessageStatus>((resolve) => client.on('messageStatus', resolve));
      await client.connect();
      const result = await client.sendText({
        to,
        from,
        text: 'smpp-ts receipt '.repeat(12),
        registeredDelivery: true,
      });
      const outcome = await status;
      expect(outcome.messageIds).toEqual(result.messageIds);
      expect(outcome.outcome).not.toBe('TIMEOUT');
      expect(reports.map((r) => r.messageId)).toEqual(expect.arrayContaining(result.messageIds));
    },
    dlrTimeout + 10_000,
  );
});
