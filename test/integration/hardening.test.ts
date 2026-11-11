import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodePdu, encodePdu } from '../../src/codec/pdu.js';
import {
  COMMAND_STATUS,
  SmppAbortError,
  SmppClient,
  type SmppClientOptions,
  SmppServer,
  type SmppServerOptions,
  SmppStatusError,
  SmppValidationError,
} from '../../src/index.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startServer(options: Partial<SmppServerOptions> = {}) {
  let id = 0;
  const server = new SmppServer({
    authenticate: ({ system_id, password }) => system_id === 'acme' && password === 'secret',
    handlers: { submit_sm: () => ({ message_id: `M${++id}` }) },
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
    reconnect: false,
    retry: false,
    ...options,
  });
  cleanups.push(() => client.close());
  return client;
}

function rawConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
    cleanups.push(async () => socket.destroy());
  });
}

const submit = { source_addr: 'A', destination_addr: '2250700000000', short_message: Buffer.from('hi') };

describe('#6: reading pauses while the write buffer is full', () => {
  it('a peer that never reads its responses cannot grow the server write buffer', async () => {
    const { server, port } = await startServer();
    const socket = await rawConnect(port);
    socket.pause(); // never reads the enquire_link_resp

    // 16 MiB of enquire_link (allowed before bind): as many responses if the server kept reading.
    const pdus = Buffer.concat(
      Array.from({ length: 4096 }, (_, i) => encodePdu({ command: 'enquire_link', sequence_number: i + 1 })),
    );
    let peak = 0;
    const sample = () => {
      for (const ss of server.sessions) peak = Math.max(peak, ss.session.socket.writableLength);
    };
    for (let i = 0; i < 256 && !socket.destroyed; i++) {
      socket.write(pdus);
      sample();
      if (i % 16 === 0) await sleep(5);
    }
    for (let i = 0; i < 50; i++) {
      await sleep(20);
      sample();
    }
    // Reading stops at the stream's high-water mark: the buffer stays around 16 KiB, far from MiBs.
    expect(peak).toBeLessThan(256 * 1024);
    expect(server.sessions.size).toBe(1);
  });

  it('closes the session beyond maxWriteBuffer', async () => {
    const { server, port } = await startServer({ maxWriteBuffer: 4096 });
    const socket = await rawConnect(port);
    socket.pause();
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    const pdus = Buffer.concat(
      Array.from({ length: 4096 }, (_, i) => encodePdu({ command: 'enquire_link', sequence_number: i + 1 })),
    );
    // Once the kernel buffers are full, responses pile up in the server's write buffer.
    for (let i = 0; i < 1024 && !socket.destroyed && server.sessions.size > 0; i++) {
      socket.write(pdus);
      if (i % 16 === 0) await sleep(5);
    }
    // Closed by the server, not by us.
    await until(() => server.sessions.size === 0, 3_000);
    socket.destroy();
    await closed;
    await until(() => server.sessions.size === 0);
  });
});

describe('#7: inbound window', () => {
  it('pause: at most inboundWindow handlers run at once, every request is answered', async () => {
    let running = 0;
    let peak = 0;
    let n = 0;
    const { port } = await startServer({
      inboundWindow: 3,
      handlers: {
        submit_sm: async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(5);
          running--;
          return { message_id: `M${++n}` };
        },
      },
    });
    const client = makeClient(port, { window: 50 });
    await client.connect();
    const results = await Promise.all(Array.from({ length: 60 }, () => client.submit(submit)));
    expect(results).toHaveLength(60);
    expect(peak).toBe(3);
  });

  it('throttle: requests over the window get ESME_RTHROTTLED at once', async () => {
    const gate: Array<() => void> = [];
    const { port } = await startServer({
      inboundWindow: 2,
      inboundWindowPolicy: 'throttle',
      handlers: {
        submit_sm: () => new Promise((r) => gate.push(() => r({ message_id: 'OK' }))),
      },
    });
    const client = makeClient(port, { window: 10 });
    await client.connect();
    const sends = Array.from({ length: 5 }, () => client.submit(submit).catch((e: unknown) => e));
    await until(() => gate.length === 2);
    await sleep(50);
    for (const open of gate) open();
    const results = await Promise.all(sends);
    const throttled = results.filter(
      (r) => r instanceof SmppStatusError && r.status === COMMAND_STATUS.ESME_RTHROTTLED,
    );
    expect(throttled).toHaveLength(3);
    expect(results.filter((r) => !(r instanceof Error))).toHaveLength(2);
  });
});

describe('#8: connections are counted from the moment they are accepted', () => {
  it('connections waiting for their PROXY header count towards maxSessionsPerIp', async () => {
    const { server, port } = await startServer({
      maxSessionsPerIp: 2,
      proxyProtocol: { trustedProxies: ['127.0.0.1/32', '::1/128'], headerTimeout: 5_000 },
    });
    const rejected: string[] = [];
    server.on('rejected', (r) => rejected.push(r.reason));
    await rawConnect(port);
    await rawConnect(port);
    const third = await rawConnect(port);
    await new Promise<void>((r) => third.on('close', () => r()));
    expect(rejected).toEqual(['maxSessionsPerIp reached']);
  });

  it('releases the slot when a connection closes before any session', async () => {
    const { port } = await startServer({
      maxSessionsPerIp: 1,
      proxyProtocol: { trustedProxies: ['127.0.0.1/32', '::1/128'], headerTimeout: 100 },
    });
    const silent = await rawConnect(port);
    await new Promise<void>((r) => silent.on('close', () => r())); // header timeout
    // The slot is free again: a regular client (no PROXY header from a trusted proxy is mandatory).
    const again = await rawConnect(port);
    again.write('PROXY TCP4 10.0.0.1 10.0.0.2 1234 2775\r\n');
    again.write(
      encodePdu({
        command: 'bind_transceiver',
        sequence_number: 1,
        system_id: 'acme',
        password: 'secret',
        interface_version: 0x34,
      }),
    );
    const resp = await new Promise<Buffer>((r) => again.once('data', r));
    expect(decodePdu(resp).command_status).toBe(0);
  });
});

describe('#9: maxSessionsPerSystemId with concurrent binds', () => {
  it('two simultaneous binds with a slow authenticate(): only one is accepted', async () => {
    const { server } = await startServer({
      maxSessionsPerSystemId: 1,
      authenticate: async ({ password }) => {
        await sleep(100);
        return password === 'secret';
      },
    });
    const port = server.address!.port;
    const results = await Promise.allSettled([makeClient(port).connect(), makeClient(port).connect()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0]!.reason as SmppStatusError).status).toBe(COMMAND_STATUS.ESME_RBINDFAIL);
    expect(server.sessionsFor('acme')).toHaveLength(1);
  });

  it('a refused bind frees its reserved slot', async () => {
    const { port } = await startServer({ maxSessionsPerSystemId: 1 });
    const bad = makeClient(port, { bind: { mode: 'transceiver', system_id: 'acme', password: 'nope' } });
    await expect(bad.connect()).rejects.toThrow();
    await makeClient(port).connect();
  });
});

describe('AbortSignal', () => {
  it('aborted before sending: nothing is written', async () => {
    let calls = 0;
    const { port } = await startServer({
      handlers: {
        submit_sm: () => {
          calls++;
          return { message_id: 'X' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    const err = await client.submit(submit, { signal: AbortSignal.abort() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppAbortError);
    expect((err as SmppAbortError).written).toBe(false);
    await client.submit(submit);
    expect(calls).toBe(1);
  });

  it('aborted while waiting for the response: written, the window slot is released', async () => {
    const { port } = await startServer({
      handlers: { submit_sm: () => new Promise(() => {}) },
      handlerTimeout: 60_000,
    });
    const client = makeClient(port, { window: 1 });
    await client.connect();
    const ac = new AbortController();
    const pending = client.submit(submit, { signal: ac.signal }).catch((e: unknown) => e);
    await until(() => client.inflight === 1);
    ac.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(SmppAbortError);
    expect((err as SmppAbortError).written).toBe(true);
    expect(client.inflight).toBe(0);
  });

  it('sendText: aborting cancels the segments not sent yet', async () => {
    const { port } = await startServer({
      handlers: { submit_sm: () => new Promise(() => {}) },
      handlerTimeout: 60_000,
    });
    const client = makeClient(port, { window: 1 });
    await client.connect();
    const ac = new AbortController();
    const pending = client
      .sendText({ to: '2250700000000', from: 'A', text: 'x'.repeat(400), signal: ac.signal })
      .catch((e: unknown) => e);
    await until(() => client.inflight === 1);
    ac.abort();
    const err = (await pending) as { results: Array<{ error?: Error }> };
    expect(err.results).toHaveLength(3);
    expect(err.results.every((r) => r.error instanceof SmppAbortError)).toBe(true);
    expect(client.queueSize).toBe(0);
  });
});

describe('sendText: maxSegments and flash', () => {
  it('rejects a text over maxSegments before sending anything', async () => {
    let calls = 0;
    const { port } = await startServer({
      handlers: {
        submit_sm: () => {
          calls++;
          return { message_id: 'X' };
        },
      },
    });
    const client = makeClient(port, { multipart: { maxSegments: 2 } });
    await client.connect();
    const err = await client
      .sendText({ to: '2250700000000', from: 'A', text: 'x'.repeat(400) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppValidationError);
    expect((err as SmppValidationError).status).toBe(COMMAND_STATUS.ESME_RINVMSGLEN);
    expect(calls).toBe(0);
    // Per-message override.
    const ok = await client.sendText({
      to: '2250700000000',
      from: 'A',
      text: 'x'.repeat(400),
      maxSegments: 3,
    });
    expect(ok.parts).toBe(3);
  });

  it('flash sets message class 0 in data_coding', async () => {
    const codings: number[] = [];
    const { port } = await startServer({
      handlers: {
        submit_sm: (pdu) => {
          codings.push(pdu.data_coding);
          return { message_id: 'X' };
        },
      },
    });
    const client = makeClient(port);
    await client.connect();
    await client.sendText({ to: '2250700000000', from: 'A', text: 'Hello', flash: true });
    await client.sendText({ to: '2250700000000', from: 'A', text: 'Hello 🎉', flash: true });
    expect(codings).toEqual([0x10, 0x18]);
    await expect(
      client.sendText({ to: '2250700000000', from: 'A', text: 'Hello', encoding: 'latin1', flash: true }),
    ).rejects.toBeInstanceOf(SmppValidationError);
  });
});
