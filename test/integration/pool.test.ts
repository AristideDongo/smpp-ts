import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type InboundMessage,
  type MessageStatus,
  type ServerSession,
  SmppError,
  SmppPool,
  type SmppPoolOptions,
  SmppServer,
  type SmppServerOptions,
} from '../../src/index.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

/** Server that records which session handled each submit_sm. */
async function startServer(options: Partial<SmppServerOptions> = {}) {
  let id = 0;
  const handledBy: ServerSession<unknown>[] = [];
  const server = new SmppServer({
    authenticate: ({ password }) => password === 'secret',
    handlers: {
      submit_sm: (_pdu, ss) => {
        handledBy.push(ss);
        return { message_id: `M${++id}` };
      },
    },
    ...options,
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { server, port, handledBy };
}

function makePool(port: number, options: Partial<SmppPoolOptions> = {}) {
  const pool = new SmppPool({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: { initialDelay: 20, maxDelay: 100 },
    retry: false,
    ...options,
  });
  cleanups.push(() => pool.close());
  return pool;
}

/** A port where nothing listens. */
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const submit = { source_addr: 'A', destination_addr: '2250700000000', short_message: Buffer.from('hi') };

describe('SmppPool', () => {
  it('round-robin spreads the sends evenly over every bind', async () => {
    const { server, port, handledBy } = await startServer();
    const pool = makePool(port, { size: 3, strategy: 'round-robin', minBound: 3 });
    await pool.connect();
    expect(pool.boundCount).toBe(3);
    for (let i = 0; i < 30; i++) await pool.submit(submit);
    const perSession = [...server.sessions].map((s) => handledBy.filter((h) => h === s).length);
    expect(perSession).toEqual([10, 10, 10]);
  });

  it('least-busy uses every bind under concurrent load', async () => {
    const { server, port, handledBy } = await startServer({
      handlers: {
        submit_sm: async (_pdu, ss) => {
          handledBy.push(ss);
          await sleep(10);
          return { message_id: 'X' };
        },
      },
    });
    const pool = makePool(port, { size: 3, window: 2, minBound: 3 });
    await pool.connect();
    await Promise.all(Array.from({ length: 30 }, () => pool.submit(submit)));
    for (const s of server.sessions) expect(handledBy.filter((h) => h === s).length).toBeGreaterThan(5);
  });

  it('keeps sending through the other binds when one goes down', async () => {
    const { server, port } = await startServer();
    const pool = makePool(port, { size: 2, minBound: 2, reconnect: false });
    const down: number[] = [];
    pool.on('memberDown', (i) => down.push(i));
    await pool.connect();
    [...server.sessions][0]!.session.destroy();
    await until(() => pool.boundCount === 1);
    for (let i = 0; i < 5; i++) await pool.submit(submit);
    expect(down).toHaveLength(1);
  });

  it('moves a send that was not written to another bind (queue full)', async () => {
    const { port, handledBy } = await startServer();
    const pool = makePool(port, {
      members: [{ maxQueueSize: 0 }, {}],
      strategy: 'round-robin',
      minBound: 2,
    });
    await pool.connect();
    for (let i = 0; i < 4; i++) await pool.submit(submit);
    expect(handledBy).toHaveLength(4);
    expect(new Set(handledBy).size).toBe(1);
  });

  it('shares concatenation references: two binds never reuse the same one', async () => {
    const refs: number[] = [];
    const { port } = await startServer({
      handlers: {
        submit_sm: (pdu) => {
          const sm = pdu.short_message;
          if (sm[0] === 5 && sm[1] === 0 && sm[5] === 1) refs.push(sm[3]!);
          return { message_id: 'X' };
        },
      },
    });
    const pool = makePool(port, { size: 2, strategy: 'round-robin', minBound: 2 });
    await pool.connect();
    for (let i = 0; i < 4; i++) {
      await pool.sendText({ to: '2250700000000', from: 'A', text: 'x'.repeat(200) });
    }
    expect(refs).toHaveLength(4);
    for (let i = 1; i < refs.length; i++) expect(refs[i]).toBe((refs[i - 1]! + 1) & 0xff);
  });

  it('tracks a message whose receipts arrive on another bind', async () => {
    const { server, port, handledBy } = await startServer();
    const pool = makePool(port, { size: 2, minBound: 2, trackDeliveries: true });
    const statuses: MessageStatus[] = [];
    pool.on('messageStatus', (s) => statuses.push(s));
    await pool.connect();
    await until(() => [...server.sessions].every((s) => s.canDeliver));

    const result = await pool.sendText({
      to: '2250700000000',
      from: 'A',
      text: 'x'.repeat(200),
      registeredDelivery: true,
      reference: 'order-7',
    });
    expect(pool.trackedMessages).toBe(1);
    const other = [...server.sessions].find((s) => s !== handledBy[0])!;
    for (const messageId of result.messageIds) {
      await other.deliverReceipt({
        messageId,
        status: 'DELIVERED',
        source: '2250700000000',
        destination: 'A',
      });
    }
    await until(() => statuses.length === 1);
    expect(statuses[0]).toMatchObject({ outcome: 'DELIVERED', reference: 'order-7' });
  });

  it('reassembles a multipart MO whose segments arrive on different binds', async () => {
    const { server, port } = await startServer();
    const pool = makePool(port, { size: 2, minBound: 2 });
    const messages: InboundMessage[] = [];
    const delivered: number[] = [];
    pool.on('message', (m) => messages.push(m));
    pool.on('deliver', (_pdu, member) => delivered.push(member));
    await pool.connect();
    await until(() => [...server.sessions].every((s) => s.canDeliver));
    const [a, b] = [...server.sessions];
    const udh = (seq: number) => Buffer.from([5, 0, 3, 42, 2, seq]);
    const mo = { source_addr: '2250700000000', destination_addr: '1234', esm_class: 0x40 };
    await a!.deliver({ ...mo, short_message: Buffer.concat([udh(1), Buffer.from('Bonjour', 'latin1')]) });
    await b!.deliver({ ...mo, short_message: Buffer.concat([udh(2), Buffer.from(' monde', 'latin1')]) });
    await until(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ text: 'Bonjour monde', parts: 2 });
    expect(new Set(delivered).size).toBe(2);
  });

  it('connect() resolves with minBound members up; the others retry in the background', async () => {
    const { port } = await startServer();
    const pool = makePool(port, {
      members: [{ url: `smpp://127.0.0.1:${await deadPort()}`, connectTimeout: 500 }, {}],
    });
    const down: number[] = [];
    pool.on('memberDown', (i) => down.push(i));
    await pool.connect();
    expect(pool.boundCount).toBe(1);
    await until(() => down.length >= 2); // first attempt + at least one background retry
    expect(new Set(down)).toEqual(new Set([0]));
    await pool.submit(submit);
  });

  it('connect() rejects when fewer than minBound members can bind', async () => {
    const { port } = await startServer();
    const pool = makePool(port, {
      members: [{ bind: { password: 'wrong' } as never }, {}],
      minBound: 2,
      reconnect: false,
    });
    const err = await pool.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppError);
    expect((err as SmppError).code).toBe('SMPP_POOL_CONNECT');
    expect(pool.boundCount).toBe(0);
  });

  it('merges bind options per member', async () => {
    const seen: string[] = [];
    const { port } = await startServer({
      authenticate: ({ system_id }) => {
        seen.push(system_id);
        return true;
      },
    });
    const pool = makePool(port, {
      members: [{}, { bind: { system_id: 'second' } as never }],
      minBound: 2,
    });
    await pool.connect();
    expect(seen.sort()).toEqual(['acme', 'second']);
  });
});
