import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodePdu } from '../../src/codec/pdu.js';
import {
  type AuthContext,
  SmppClient,
  SmppConnectionClosedError,
  SmppServer,
  type SmppServerOptions,
  type TlsPeerInfo,
} from '../../src/index.js';
import { Session } from '../../src/session/session.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function startServer(options: Partial<SmppServerOptions> = {}) {
  const server = new SmppServer({
    authenticate: ({ system_id, password }) => system_id === 'acme' && password === 'secret',
    handlers: { submit_sm: () => ({ message_id: 'M1' }) },
    ...options,
  });
  const { port } = await server.listen(0, '127.0.0.1', 64);
  cleanups.push(() => server.close());
  return { server, port };
}

function rawConnect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
    cleanups.push(async () => socket.destroy());
  });
}

describe('connection rate (SEC-05)', () => {
  it('refuses connections opened faster than the per-address rate', async () => {
    const rejected: string[] = [];
    const { server, port } = await startServer({
      connectionRate: { perIpPerSecond: 1, perIpBurst: 2 },
    });
    server.on('rejected', (info) => rejected.push(info.reason));

    const sockets = await Promise.all([1, 2, 3, 4, 5].map(() => rawConnect(port)));
    await until(() => rejected.length >= 3, 3_000);
    expect(rejected.every((r) => r.includes('connection rate'))).toBe(true);
    // The burst got through, the rest was dropped before a single byte was read.
    expect(server.sessions.size).toBeLessThanOrEqual(2);
    const closed = sockets.filter((s) => s.destroyed || s.readyState === 'closed');
    expect(closed.length).toBeGreaterThanOrEqual(1);
  });

  it('lets a client through once the bucket refills, and a legitimate bind still works', async () => {
    const { port } = await startServer({ connectionRate: { perIpPerSecond: 50, perIpBurst: 1 } });
    const client = new SmppClient({
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
      reconnect: false,
    });
    cleanups.push(() => client.close());
    await client.connect();
    expect(client.isBound).toBe(true);
  });

  it('connectionRate: false disables the limit', async () => {
    const rejected: string[] = [];
    const { server, port } = await startServer({ connectionRate: false });
    server.on('rejected', (info) => rejected.push(info.reason));
    await Promise.all(Array.from({ length: 30 }, () => rawConnect(port)));
    await until(() => server.sessions.size === 30, 3_000);
    expect(rejected).toEqual([]);
  });
});

describe('maxTotalWriteBuffer', () => {
  it('closes the heaviest sessions when the write buffers add up beyond the budget', async () => {
    // Per-session limit disabled: only the aggregate budget can close these sessions.
    const { server, port } = await startServer({ maxWriteBuffer: 0, maxTotalWriteBuffer: 4096 });
    const sockets = await Promise.all([1, 2].map(() => rawConnect(port)));
    for (const socket of sockets) socket.pause(); // never reads the enquire_link_resp

    const pdus = Buffer.concat(
      Array.from({ length: 2048 }, (_, i) => encodePdu({ command: 'enquire_link', sequence_number: i + 1 })),
    );
    for (let i = 0; i < 256 && server.sessions.size > 0; i++) {
      for (const socket of sockets) if (!socket.destroyed) socket.write(pdus);
      if (i % 8 === 0) await sleep(5);
    }
    await until(() => server.sessions.size === 0, 5_000);
    expect(server.bufferedBytes).toBe(0);
  });

  it('leaves quiet sessions alone', async () => {
    const { server, port } = await startServer({ maxTotalWriteBuffer: 4096 });
    const client = new SmppClient({
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
      reconnect: false,
    });
    cleanups.push(() => client.close());
    await client.connect();
    await sleep(700); // at least one watchdog tick
    expect(client.isBound).toBe(true);
    expect(server.sessions.size).toBe(1);
  });
});

describe('SmppConnectionClosedError.written', () => {
  it('reports written: false for a request the socket never took', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((r) => server.once('connection', r));
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    const peer = await accepted;
    cleanups.push(async () => {
      socket.destroy();
      peer.destroy();
      server.close();
    });

    const session = new Session(socket, { role: 'esme', enquireLinkInterval: 0 });
    session.markBound('transceiver', 'acme');
    // The socket is gone, but the session has not seen its `close` event yet.
    socket.destroy();
    const pending = session.request('submit_sm', { destination_addr: '1' });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmppConnectionClosedError);
    expect((err as SmppConnectionClosedError).written).toBe(false);
    expect((err as Error).message).toContain('was not written');
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenssl())('client certificate authentication (mTLS, SEC-06)', () => {
  let dir: string;
  let serverKey: string;
  let serverCert: string;
  let clientCa: string;
  let clientKey: string;
  let clientCert: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'smpp-ts-mtls-'));
    const at = (f: string) => join(dir, f);
    const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
    // Server certificate (self-signed, valid for 127.0.0.1).
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      at('server.key'),
      '-out',
      at('server.pem'),
    ]);
    // A CA of our own, and a client certificate signed by it.
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=smpp-ts-test-ca',
      '-keyout',
      at('ca.key'),
      '-out',
      at('ca.pem'),
    ]);
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=acme-client',
      '-keyout',
      at('client.key'),
      '-out',
      at('client.csr'),
    ]);
    openssl([
      'x509',
      '-req',
      '-in',
      at('client.csr'),
      '-days',
      '1',
      '-CA',
      at('ca.pem'),
      '-CAkey',
      at('ca.key'),
      '-set_serial',
      '1',
      '-out',
      at('client.pem'),
    ]);
    serverKey = readFileSync(at('server.key'), 'utf8');
    serverCert = readFileSync(at('server.pem'), 'utf8');
    clientCa = readFileSync(at('ca.pem'), 'utf8');
    clientKey = readFileSync(at('client.key'), 'utf8');
    clientCert = readFileSync(at('client.pem'), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function mtlsServer(seen: TlsPeerInfo[], rejectUnauthorized: boolean) {
    const server = new SmppServer({
      // The certificate decides, not the password.
      authenticate: (ctx: AuthContext) => {
        if (ctx.tls) seen.push(ctx.tls);
        const cn = (ctx.tls?.subject as { CN?: string } | undefined)?.CN;
        return cn === 'acme-client';
      },
      tls: { key: serverKey, cert: serverCert, ca: [clientCa], requestCert: true, rejectUnauthorized },
    });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    return port;
  }

  function mtlsClient(port: number, withCert: boolean) {
    const client = new SmppClient({
      url: `ssmpp://127.0.0.1:${port}`,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'unused' },
      tls: withCert ? { ca: serverCert, cert: clientCert, key: clientKey } : { ca: serverCert },
      reconnect: false,
    });
    cleanups.push(() => client.close());
    return client;
  }

  it('hands the verified client certificate to authenticate()', async () => {
    const seen: TlsPeerInfo[] = [];
    const port = await mtlsServer(seen, true);
    const client = mtlsClient(port, true);
    await client.connect();
    expect(client.isBound).toBe(true);
    expect(seen[0]?.authorized).toBe(true);
    expect((seen[0]?.subject as { CN?: string }).CN).toBe('acme-client');
    expect((seen[0]?.issuer as { CN?: string }).CN).toBe('smpp-ts-test-ca');
    expect(seen[0]?.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(seen[0]?.fingerprint256).toMatch(/^[0-9A-F:]+$/);
  });

  it('refuses a client that sends no certificate before the bind', async () => {
    const seen: TlsPeerInfo[] = [];
    const port = await mtlsServer(seen, true);
    await expect(mtlsClient(port, false).connect()).rejects.toThrow();
    // TLS refused the handshake: the hook was never reached.
    expect(seen).toEqual([]);
  });

  it('with rejectUnauthorized: false the hook sees the certificate but not a verdict', async () => {
    const seen: TlsPeerInfo[] = [];
    const port = await mtlsServer(seen, false);
    const client = mtlsClient(port, true);
    await client.connect();
    expect(client.isBound).toBe(true);
    // Node skips verification in this mode: `authorized` stays false, the identity is still there.
    expect(seen[0]?.authorized).toBe(false);
    expect((seen[0]?.subject as { CN?: string }).CN).toBe('acme-client');
    expect(seen[0]?.fingerprint256).toMatch(/^[0-9A-F:]+$/);
  });
});
