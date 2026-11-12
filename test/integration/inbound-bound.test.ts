import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_STATUS, type DeliverSm, SmppClient, SmppPool, SmppStatusError } from '../../src/index.js';
import { type TestSmsc, createTestSmsc } from '../../src/testing/index.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function setup(options: { maxPendingInbound?: number } = {}) {
  const smsc = await createTestSmsc();
  cleanups.push(() => smsc.close());
  const client = new SmppClient({
    url: smsc.url,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
    autoAck: false,
    reconnect: { initialDelay: 10, maxDelay: 20 },
    ...options,
  });
  cleanups.push(() => client.close());
  await client.connect();
  const delivered: DeliverSm[] = [];
  client.on('deliver', (pdu) => delivered.push(pdu));
  return { smsc, client, delivered };
}

function deliver(smsc: TestSmsc, text: string) {
  return smsc.sessions[0]!.deliver({
    source_addr: '2250700000000',
    destination_addr: '1234',
    short_message: Buffer.from(text, 'latin1'),
  });
}

describe('maxPendingInbound (autoAck: false)', () => {
  it('answers ESME_RX_T_APPN beyond the bound, without emitting', async () => {
    const { smsc, client, delivered } = await setup({ maxPendingInbound: 2 });
    const first = deliver(smsc, 'a');
    const second = deliver(smsc, 'b');
    await until(() => delivered.length === 2);
    expect(client.pendingInboundCount).toBe(2);

    const err = await deliver(smsc, 'c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppStatusError);
    expect((err as SmppStatusError).status).toBe(COMMAND_STATUS.ESME_RX_T_APPN);
    expect(delivered).toHaveLength(2);

    client.respond(delivered[0]!);
    await expect(first).resolves.toBeDefined();
    expect(client.pendingInboundCount).toBe(1);
    // room again
    const fourth = deliver(smsc, 'd');
    await until(() => delivered.length === 3);
    client.respond(delivered[1]!);
    client.respond(delivered[2]!);
    await Promise.all([second, fourth]);
    expect(client.pendingInboundCount).toBe(0);
  });

  it('answering twice does nothing', async () => {
    const { smsc, client, delivered } = await setup();
    const p = deliver(smsc, 'a');
    await until(() => delivered.length === 1);
    client.respond(delivered[0]!);
    client.respond(delivered[0]!);
    await p;
    expect(client.pendingInboundCount).toBe(0);
  });

  it('a PDU answered after a reconnection is not answered on the new session', async () => {
    const { smsc, client, delivered } = await setup();
    void deliver(smsc, 'a').catch(() => {});
    await until(() => delivered.length === 1);
    const reconnected = new Promise<void>((resolve) => client.once('reconnected', () => resolve()));
    smsc.disconnectAll();
    await reconnected;
    // The server numbers again from 1 on the new session: 'b' gets the sequence_number of 'a'.
    const next = deliver(smsc, 'b');
    await until(() => delivered.length === 2);
    expect(delivered[1]!.sequence_number).toBe(delivered[0]!.sequence_number);
    client.respond(delivered[0]!); // stale: its session is gone, must not answer 'b'
    let settled = false;
    void next.finally(() => {
      settled = true;
    });
    await sleep(50);
    expect(settled).toBe(false);
    expect(client.pendingInboundCount).toBe(1);
    client.respond(delivered[1]!);
    await expect(next).resolves.toBeDefined();
  });

  it('pool.respond answers through the bind the PDU came on', async () => {
    const smsc = await createTestSmsc();
    cleanups.push(() => smsc.close());
    const pool = new SmppPool({
      url: smsc.url,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
      size: 2,
      minBound: 2,
      autoAck: false,
    });
    cleanups.push(() => pool.close());
    await pool.connect();
    const got: Array<[DeliverSm, number]> = [];
    pool.on('deliver', (pdu, member) => got.push([pdu, member]));
    const [a, b] = smsc.sessions;
    const pa = a!.deliver({ source_addr: '1', destination_addr: '2', short_message: Buffer.from('x') });
    const pb = b!.deliver({ source_addr: '1', destination_addr: '2', short_message: Buffer.from('y') });
    await until(() => got.length === 2);
    expect(new Set(got.map(([, m]) => m)).size).toBe(2);
    expect(pool.pendingInboundCount).toBe(2);
    for (const [pdu] of got) pool.respond(pdu);
    await Promise.all([pa, pb]);
    expect(pool.pendingInboundCount).toBe(0);
  });
});
