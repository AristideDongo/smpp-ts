import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decodePdu, encodePdu } from '../../src/codec/pdu.js';
import { SmppClient, SmppServer } from '../../src/index.js';
import { until } from '../helpers/raw-smsc.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

const authenticate = ({ system_id }: { system_id: string }) => system_id === 'acme';

describe.skipIf(!hasOpenssl())('TLS (SEC-01)', () => {
  let dir: string;
  let key: string;
  let cert: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'smpp-ts-tls-'));
    execFileSync(
      'openssl',
      [
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
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    key = readFileSync(join(dir, 'key.pem'), 'utf8');
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function tlsServer() {
    const server = new SmppServer({
      authenticate,
      tls: { key, cert },
      handlers: { submit_sm: () => ({ message_id: 'tls' }) },
    });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    return port;
  }

  it('refuses a self-signed certificate by default', async () => {
    const port = await tlsServer();
    const client = new SmppClient({
      url: `ssmpp://localhost:${port}`,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
      reconnect: false,
    });
    cleanups.push(() => client.close());
    await expect(client.connect()).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it('accepts it when its CA is provided via tls.ca', async () => {
    const port = await tlsServer();
    const client = new SmppClient({
      url: `ssmpp://localhost:${port}`,
      tls: { ca: cert },
      bind: { mode: 'transceiver', system_id: 'acme', password: 'x' },
      reconnect: false,
    });
    cleanups.push(() => client.close());
    await client.connect();
    expect((await client.submit({ destination_addr: '1' })).message_id).toBe('tls');
  });
});

describe('Proxy Protocol (SEC-08)', () => {
  async function proxyServer(trustedProxies: string[]) {
    const server = new SmppServer({ authenticate, proxyProtocol: { trustedProxies, headerTimeout: 500 } });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    return { server, port };
  }

  async function rawBind(port: number, prefix: Buffer) {
    const sock = net.connect(port, '127.0.0.1');
    cleanups.push(async () => sock.destroy());
    await new Promise((r) => sock.once('connect', r));
    sock.write(
      Buffer.concat([prefix, encodePdu({ command: 'bind_transceiver', system_id: 'acme', password: 'x' })]),
    );
    return sock;
  }

  it('uses the client address from a trusted proxy (v1)', async () => {
    const { server, port } = await proxyServer(['127.0.0.0/8']);
    const sock = await rawBind(port, Buffer.from('PROXY TCP4 203.0.113.7 10.0.0.1 40000 2775\r\n'));
    const data: Buffer = await new Promise((r) => sock.once('data', r));
    expect(decodePdu(data)).toMatchObject({ command: 'bind_transceiver_resp', command_status: 0 });
    await until(() => server.sessions.size === 1);
    expect([...server.sessions][0]!.remoteAddress).toBe('203.0.113.7');
  });

  it('rejects a PROXY header from an untrusted address', async () => {
    const { server, port } = await proxyServer(['10.0.0.0/8']);
    const rejected: string[] = [];
    server.on('rejected', (r) => rejected.push(r.reason));
    const sock = await rawBind(port, Buffer.from('PROXY TCP4 203.0.113.7 10.0.0.1 40000 2775\r\n'));
    await new Promise((r) => sock.once('close', r));
    expect(server.sessions.size).toBe(0);
  });

  it('accepts direct connections from untrusted addresses without header', async () => {
    const { port } = await proxyServer(['10.0.0.0/8']);
    const sock = await rawBind(port, Buffer.alloc(0));
    const data: Buffer = await new Promise((r) => sock.once('data', r));
    expect(decodePdu(data).command_status).toBe(0);
  });

  it('closes a trusted connection that sends an invalid header', async () => {
    const { server, port } = await proxyServer(['127.0.0.1']);
    const sock = await rawBind(port, Buffer.from('PROXY GARBAGE\r\n'));
    await new Promise((r) => sock.once('close', r));
    expect(server.sessions.size).toBe(0);
  });

  it('requires a non-empty trusted proxy list', () => {
    expect(() => new SmppServer({ authenticate, proxyProtocol: { trustedProxies: [] } })).toThrow(
      /trustedProxies/,
    );
  });
});

describe('server robustness', () => {
  it('nacks garbage from a client and keeps the session', async () => {
    const server = new SmppServer({ authenticate });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    const sock = net.connect(port, '127.0.0.1');
    cleanups.push(async () => sock.destroy());
    await new Promise((r) => sock.once('connect', r));
    const unknown = Buffer.alloc(16);
    unknown.writeUInt32BE(16, 0);
    unknown.writeUInt32BE(0x00000555, 4);
    unknown.writeUInt32BE(12, 12);
    sock.write(unknown);
    const data: Buffer = await new Promise((r) => sock.once('data', r));
    expect(decodePdu(data)).toMatchObject({
      command: 'generic_nack',
      sequence_number: 12,
      command_status: 3,
    });
    sock.write(encodePdu({ command: 'enquire_link', sequence_number: 13 }));
    const data2: Buffer = await new Promise((r) => sock.once('data', r));
    expect(decodePdu(data2)).toMatchObject({ command: 'enquire_link_resp', sequence_number: 13 });
  });

  it('requires an authenticate hook', () => {
    expect(() => new SmppServer({} as never)).toThrow(/authenticate/);
  });
});
