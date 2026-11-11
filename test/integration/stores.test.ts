import { afterEach, describe, expect, it } from 'vitest';
import {
  type DeliveryTrackerStore,
  type MessageStatus,
  SmppClient,
  type SmppClientOptions,
  SmppServer,
  type TrackedMessageRecord,
} from '../../src/index.js';
import { until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startServer(
  onSubmit: (pdu: { sequence_number: number; short_message: Buffer }) => void = () => {},
) {
  let id = 0;
  const server = new SmppServer({
    authenticate: () => true,
    handlers: {
      submit_sm: (pdu) => {
        onSubmit(pdu);
        return { message_id: `M${++id}` };
      },
    },
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { server, port };
}

function client(port: number, options: Partial<SmppClientOptions> = {}) {
  const c = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
    reconnect: false,
    ...options,
  });
  cleanups.push(() => c.close());
  return c;
}

describe('pluggable stores', () => {
  it('a restarted client finishes tracking a message sent before the restart', async () => {
    const data = new Map<string, string>();
    const store: DeliveryTrackerStore = {
      save: (r) => {
        data.set(r.key, JSON.stringify(r));
      },
      delete: (k) => {
        data.delete(k);
      },
      load: () => [...data.values()].map((v) => JSON.parse(v) as TrackedMessageRecord),
    };
    const { server, port } = await startServer();

    const first = client(port, { trackDeliveries: { store } });
    await first.connect();
    const sent = await first.sendText({
      to: '2250700000000',
      from: 'A',
      text: 'x'.repeat(200),
      registeredDelivery: true,
      reference: 'order-9',
    });
    await first.close();
    expect(data.size).toBe(1);

    const second = client(port, { trackDeliveries: { store } });
    const statuses: MessageStatus[] = [];
    second.on('messageStatus', (s) => statuses.push(s));
    await second.connect();
    expect(second.trackedMessages).toBe(1);
    await until(() => [...server.sessions].some((s) => s.canDeliver));
    const ss = [...server.sessions].find((s) => s.canDeliver)!;
    for (const messageId of sent.messageIds) {
      await ss.deliverReceipt({ messageId, status: 'DELIVERED', source: '2250700000000', destination: 'A' });
    }
    await until(() => statuses.length === 1);
    expect(statuses[0]).toMatchObject({ outcome: 'DELIVERED', reference: 'order-9' });
    expect(data.size).toBe(0);
  });

  it('sequenceGenerator provides the sequence_number of every request', async () => {
    const seen: number[] = [];
    const { port } = await startServer((pdu) => seen.push(pdu.sequence_number));
    let next = 5000;
    const c = client(port, { sequenceGenerator: { next: () => next++ }, enquireLinkInterval: 0 });
    await c.connect(); // bind uses 5000
    await c.submit({ source_addr: 'A', destination_addr: '1', short_message: Buffer.from('a') });
    await c.submit({ source_addr: 'A', destination_addr: '1', short_message: Buffer.from('b') });
    expect(seen).toEqual([5001, 5002]);
  });

  it('sequenceGenerator values out of range are wrapped into 1..0x7FFFFFFF', async () => {
    const seen: number[] = [];
    const { port } = await startServer((pdu) => seen.push(pdu.sequence_number));
    const c = client(port, { sequenceGenerator: { next: () => 0x80000005 }, enquireLinkInterval: 0 });
    await c.connect();
    await c.submit({ source_addr: 'A', destination_addr: '1', short_message: Buffer.from('a') });
    expect(seen[0]).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toBeLessThanOrEqual(0x7fffffff);
  });

  it('concatReference provides the reference of long messages', async () => {
    const refs: number[] = [];
    const { port } = await startServer((pdu) => {
      const sm = pdu.short_message;
      if (sm[0] === 5 && sm[5] === 1) refs.push(sm[3]!);
    });
    let n = 0x1234;
    const c = client(port, { concatReference: () => n++ });
    await c.connect();
    await c.sendText({ to: '2250700000000', from: 'A', text: 'x'.repeat(200) });
    await c.sendText({ to: '2250700000000', from: 'A', text: 'x'.repeat(200) });
    expect(refs).toEqual([0x34, 0x35]); // 8-bit UDH keeps the low byte
  });
});
