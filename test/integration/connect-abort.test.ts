import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmppAbortError, SmppClient, SmppPool, SmppServer } from '../../src/index.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function slowServer(authDelayMs: number) {
  const server = new SmppServer({
    authenticate: async () => {
      await sleep(authDelayMs);
      return true;
    },
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { server, port };
}

function client(port: number) {
  const c = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
    reconnect: false,
  });
  cleanups.push(() => c.close());
  return c;
}

describe('connect({ signal })', () => {
  it('an already aborted signal rejects at once, without connecting', async () => {
    let connections = 0;
    const tcp = net.createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise((r) => tcp.close(() => r(undefined))));
    const { port } = tcp.address() as net.AddressInfo;

    const err = await client(port)
      .connect({ signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppAbortError);
    await sleep(50);
    expect(connections).toBe(0);
  });

  it('aborting during the bind rejects with SmppAbortError and closes the connection', async () => {
    const { server, port } = await slowServer(2_000);
    const c = client(port);
    const ac = new AbortController();
    const pending = c.connect({ signal: ac.signal }).catch((e: unknown) => e);
    await until(() => server.sessions.size === 1);
    ac.abort();
    expect(await pending).toBeInstanceOf(SmppAbortError);
    expect(c.state).toBe('CLOSED');
    await until(() => server.sessions.size === 0);
  });

  it('a signal aborted after a successful connect has no effect', async () => {
    const { port } = await slowServer(0);
    const c = client(port);
    const ac = new AbortController();
    await c.connect({ signal: ac.signal });
    ac.abort();
    await sleep(20);
    expect(c.isBound).toBe(true);
  });

  it('SmppPool.connect: aborting closes every member', async () => {
    const { port } = await slowServer(2_000);
    const pool = new SmppPool({
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
      size: 2,
    });
    cleanups.push(() => pool.close());
    const ac = new AbortController();
    const pending = pool.connect({ signal: ac.signal }).catch((e: unknown) => e);
    await sleep(50);
    ac.abort();
    expect(await pending).toBeInstanceOf(SmppAbortError);
    expect(pool.boundCount).toBe(0);
  });
});
