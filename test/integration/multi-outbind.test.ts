import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Framer } from '../../src/codec/framer.js';
import { type Pdu, type PduInput, decodePdu, encodePdu } from '../../src/codec/pdu.js';
import {
  COMMAND_STATUS,
  type DestAddress,
  OutbindServer,
  SmppClient,
  SmppPool,
  SmppServer,
  SmppValidationError,
  safeCompare,
} from '../../src/index.js';
import { until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

// ---------------------------------------------------------------- submit_multi

interface MultiCall {
  dest_address: DestAddress[];
  short_message: Buffer;
  esm_class: number;
}

async function startMultiServer(refuse: (addr: string) => number | undefined = () => undefined) {
  const calls: MultiCall[] = [];
  let id = 0;
  const server = new SmppServer({
    authenticate: ({ password }) => safeCompare(password, 'secret'),
    handlers: {
      submit_multi: (pdu) => {
        calls.push({
          dest_address: pdu.dest_address,
          short_message: pdu.short_message,
          esm_class: pdu.esm_class,
        });
        const unsuccess_sme = pdu.dest_address.flatMap((d) => {
          if (d.dest_flag !== 1) return [];
          const status = refuse(d.destination_addr);
          return status === undefined
            ? []
            : [
                {
                  dest_addr_ton: d.dest_addr_ton,
                  dest_addr_npi: d.dest_addr_npi,
                  destination_addr: d.destination_addr,
                  error_status_code: status,
                },
              ];
        });
        return { message_id: `M${++id}`, unsuccess_sme };
      },
      submit_sm: () => ({ message_id: `S${++id}` }),
    },
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { port, calls };
}

function makeClient(port: number) {
  const client = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: false,
  });
  cleanups.push(() => client.close());
  return client;
}

describe('sendTextMulti', () => {
  it('sends one submit_multi to every destination and a distribution list', async () => {
    const { port, calls } = await startMultiServer();
    const client = makeClient(port);
    await client.connect();
    const result = await client.sendTextMulti({
      from: 'ACME',
      to: ['22507000001', '22507000002', { list: 'vip' }],
      text: 'hello',
    });
    expect(result).toEqual({ messageIds: ['M1'], parts: 1, encoding: 'GSM7', replacements: 0, refused: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.dest_address).toEqual([
      { dest_flag: 1, dest_addr_ton: 0, dest_addr_npi: 1, destination_addr: '22507000001' },
      { dest_flag: 1, dest_addr_ton: 0, dest_addr_npi: 1, destination_addr: '22507000002' },
      { dest_flag: 2, dl_name: 'vip' },
    ]);
    expect(calls[0]?.short_message.toString('latin1')).toBe('hello');
  });

  it('lists the destinations the SMSC refused without failing', async () => {
    const { port } = await startMultiServer((addr) =>
      addr === '22507000002' ? COMMAND_STATUS.ESME_RINVDSTADR : undefined,
    );
    const client = makeClient(port);
    await client.connect();
    const result = await client.sendTextMulti({
      from: 'ACME',
      to: ['22507000001', '22507000002'],
      text: 'hello',
    });
    expect(result.messageIds).toEqual(['M1']);
    expect(result.refused).toEqual([
      { to: '22507000002', part: 0, status: COMMAND_STATUS.ESME_RINVDSTADR, statusName: 'ESME_RINVDSTADR' },
    ]);
  });

  it('splits a long text: one submit_multi per segment, with UDH', async () => {
    const { port, calls } = await startMultiServer();
    const client = makeClient(port);
    await client.connect();
    const result = await client.sendTextMulti({ from: 'ACME', to: ['22507000001'], text: 'x'.repeat(200) });
    expect(result.parts).toBe(2);
    expect(result.messageIds).toEqual(['M1', 'M2']);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => (c.esm_class & 0x40) !== 0)).toBe(true);
  });

  it('validates the number of destinations and list names before sending', async () => {
    const { port, calls } = await startMultiServer();
    const client = makeClient(port);
    await client.connect();
    await expect(client.sendTextMulti({ from: 'ACME', to: [], text: 'x' })).rejects.toBeInstanceOf(
      SmppValidationError,
    );
    await expect(
      client.sendTextMulti({
        from: 'ACME',
        to: Array.from({ length: 255 }, (_, i) => `2250700${i}`),
        text: 'x',
      }),
    ).rejects.toThrow(/1 to 254/);
    await expect(client.sendTextMulti({ from: 'ACME', to: [{ list: '' }], text: 'x' })).rejects.toThrow(
      /distribution list/,
    );
    expect(calls).toHaveLength(0);
  });

  it('is refused locally in receiver mode and works through a pool', async () => {
    const { port, calls } = await startMultiServer();
    const rx = new SmppClient({
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'receiver', system_id: 'acme', password: 'secret' },
      reconnect: false,
    });
    cleanups.push(() => rx.close());
    await rx.connect();
    await expect(rx.sendTextMulti({ from: 'ACME', to: ['22507000001'], text: 'x' })).rejects.toThrow(
      /not allowed in receiver mode/,
    );

    const pool = new SmppPool({
      size: 2,
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'transmitter', system_id: 'acme', password: 'secret' },
      reconnect: false,
    });
    cleanups.push(() => pool.close());
    await pool.connect();
    const result = await pool.sendTextMulti({ from: 'ACME', to: ['22507000001'], text: 'x' });
    expect(result.messageIds).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // The other per-message shortcuts go through the same member selection.
    await expect(pool.query('M1')).rejects.toThrow(/ESME_RSYSERR|query_sm/);
    await expect(pool.cancel('M1', { destination_addr: '22507000001' })).rejects.toThrow(
      /ESME_RSYSERR|cancel_sm/,
    );
    await expect(pool.replace('M1', { short_message: Buffer.from('y') })).rejects.toThrow(
      /ESME_RSYSERR|replace_sm/,
    );
    await expect(rx.replace('M1', { short_message: Buffer.from('y') })).rejects.toThrow(/not allowed/);
  });
});

// ---------------------------------------------------------------- outbind

/** An SMSC that initiates the session: connects, sends outbind, then answers the bind. */
async function connectAsSmsc(port: number, first: PduInput[] = [], answerBind = true) {
  const socket = net.connect({ host: '127.0.0.1', port });
  cleanups.push(async () => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => {});
  const received: Pdu[] = [];
  const framer = new Framer();
  const closed = new Promise<void>((r) => socket.once('close', () => r()));
  socket.on('data', (chunk) => {
    for (const f of framer.push(chunk).frames) {
      const pdu = decodePdu(f);
      received.push(pdu);
      if (answerBind && pdu.command === 'bind_receiver') {
        socket.write(
          encodePdu({
            command: 'bind_receiver_resp',
            sequence_number: pdu.sequence_number,
            system_id: 'SMSC',
          }),
        );
      }
    }
  });
  if (first.length) socket.write(Buffer.concat(first.map((p) => encodePdu(p))));
  return {
    socket,
    received,
    closed,
    send: (pdu: PduInput) => socket.write(encodePdu(pdu)),
  };
}

function startOutbind(options: Partial<ConstructorParameters<typeof OutbindServer>[0]> = {}) {
  const outbind = new OutbindServer({
    authenticate: ({ system_id, password }) => system_id === 'smsc' && safeCompare(password, 'pw'),
    client: { bind: { system_id: 'acme', password: 'secret' }, enquireLinkInterval: 0, unbindTimeout: 200 },
    outbindTimeout: 300,
    ...options,
  });
  cleanups.push(() => outbind.close());
  return outbind;
}

describe('OutbindServer', () => {
  it('binds as receiver on an outbind and delivers messages to the client', async () => {
    const outbind = startOutbind();
    const { port } = await outbind.listen(0, '127.0.0.1');
    const sessions: Array<{ client: SmppClient; systemId: string }> = [];
    outbind.on('session', (client, info) => sessions.push({ client, systemId: info.system_id }));

    const smsc = await connectAsSmsc(port, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' },
    ]);
    await until(() => sessions.length === 1);
    const client = sessions[0]!.client;
    expect(sessions[0]?.systemId).toBe('smsc');
    expect(client.state).toBe('BOUND_RX');
    expect(smsc.received.map((p) => p.command)).toEqual(['bind_receiver']);
    const bind = smsc.received[0] as Pdu & { system_id: string; password: string };
    expect(bind.system_id).toBe('acme');
    expect(bind.password).toBe('secret');
    expect(outbind.sessions.size).toBe(1);

    const texts: string[] = [];
    client.on('message', (m) => texts.push(m.text ?? ''));
    smsc.send({
      command: 'deliver_sm',
      sequence_number: 2,
      source_addr: '2250700000000',
      destination_addr: '1234',
      short_message: Buffer.from('hi from the SMSC'),
    });
    await until(() => texts.length === 1);
    expect(texts).toEqual(['hi from the SMSC']);
    await until(() => smsc.received.some((p) => p.command === 'deliver_sm_resp'));

    // The SMSC drops the connection: the client closes for good, nothing reconnects.
    smsc.socket.destroy();
    await until(() => client.state === 'CLOSED');
    expect(outbind.sessions.size).toBe(0);
  });

  it('keeps bytes that follow the outbind in the same packet', async () => {
    const outbind = startOutbind();
    const { port } = await outbind.listen(0, '127.0.0.1');
    const sessions: SmppClient[] = [];
    outbind.on('session', (client) => sessions.push(client));
    const smsc = await connectAsSmsc(port, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' },
      { command: 'enquire_link', sequence_number: 2 },
    ]);
    await until(() => sessions.length === 1);
    await until(() => smsc.received.some((p) => p.command === 'enquire_link_resp'));
  });

  it('refuses bad credentials, a wrong first PDU and a silent peer, without a hint', async () => {
    const outbind = startOutbind();
    const { port } = await outbind.listen(0, '127.0.0.1');
    const rejected: string[] = [];
    outbind.on('rejected', (reason) => rejected.push(reason));

    const bad = await connectAsSmsc(port, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'nope' },
    ]);
    await bad.closed;
    expect(bad.received).toEqual([]);

    const wrong = await connectAsSmsc(port, [{ command: 'enquire_link', sequence_number: 1 }]);
    await wrong.closed;

    const silent = await connectAsSmsc(port);
    await silent.closed;

    expect(rejected).toEqual(['credentials', 'protocol', 'timeout']);
    expect(outbind.sessions.size).toBe(0);
  });

  it('reports a bind the SMSC refuses and enforces maxSessions', async () => {
    const outbind = startOutbind({
      maxSessions: 1,
      client: { bind: { system_id: 'acme', password: 'secret' }, bindTimeout: 300, unbindTimeout: 200 },
    });
    const { port } = await outbind.listen(0, '127.0.0.1');
    const rejected: string[] = [];
    outbind.on('rejected', (reason) => rejected.push(reason));

    const noAnswer = await connectAsSmsc(
      port,
      [{ command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' }],
      false,
    );
    await noAnswer.closed;
    await until(() => rejected.length === 1);
    expect(rejected).toEqual(['bind']);

    const sessions: SmppClient[] = [];
    outbind.on('session', (client) => sessions.push(client));
    await connectAsSmsc(port, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' },
    ]);
    await until(() => sessions.length === 1);
    const extra = await connectAsSmsc(port, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' },
    ]);
    await extra.closed;
    expect(rejected).toEqual(['bind', 'limit']);

    await outbind.close({ timeout: 200 });
    expect(sessions[0]!.state).toBe('CLOSED');
  });

  it('surfaces listen errors on the error event, or on the logger without a listener', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    cleanups.push(async () => taken.close());
    const port = (taken.address() as net.AddressInfo).port;
    const outbind = startOutbind();
    expect(outbind.address).toBeUndefined();
    await expect(outbind.listen(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    const errors: string[] = [];
    outbind.on('error', (err) => errors.push(err.code));
    (outbind as unknown as { server: net.Server }).server.emit('error', new Error('boom'));
    expect(errors).toEqual(['SMPP_SERVER']);
    const logged: string[] = [];
    const quiet = new OutbindServer({
      authenticate: () => {
        throw new Error('db down');
      },
      client: { bind: { system_id: 'acme', password: 'secret' } },
      logger: { debug() {}, info() {}, warn() {}, error: (m) => logged.push(m) },
    });
    cleanups.push(() => quiet.close());
    (quiet as unknown as { server: net.Server }).server.emit('error', new Error('boom'));
    expect(logged).toEqual(['boom']);
    // authenticate() throwing is a refusal, logged, never a hint to the peer.
    const { port: p2 } = await quiet.listen(0, '127.0.0.1');
    expect(quiet.address?.port).toBe(p2);
    const rejected: string[] = [];
    quiet.on('rejected', (reason) => rejected.push(reason));
    const smsc = await connectAsSmsc(p2, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' },
    ]);
    await smsc.closed;
    expect(rejected).toEqual(['credentials']);
    expect(logged).toContain('outbind authenticate failed');
    expect(
      () =>
        new OutbindServer({ authenticate: () => true, client: { bind: { system_id: '', password: 'x' } } }),
    ).toThrow(/system_id/);
  });

  it('binds the client on a provided socket only once', async () => {
    const server = new SmppServer({ authenticate: () => true });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((r) => socket.once('connect', r));
    const client = new SmppClient({ socket, bind: { mode: 'transceiver', system_id: 'a', password: 'b' } });
    cleanups.push(() => client.close());
    await client.connect();
    expect(client.state).toBe('BOUND_TRX');
    await expect(client.rebind()).rejects.toThrow(/already bound/);
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

describe.skipIf(!hasOpenssl())('OutbindServer over TLS', () => {
  let dir: string;
  let key: string;
  let cert: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'smpp-ts-outbind-tls-'));
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

  it('binds after the handshake, and rejects a peer that fails it', async () => {
    const outbind = new OutbindServer({
      authenticate: ({ password }) => safeCompare(password, 'pw'),
      client: { bind: { system_id: 'acme', password: 'secret' }, enquireLinkInterval: 0, unbindTimeout: 200 },
      tls: { key, cert },
      handshakeTimeout: 500,
    });
    cleanups.push(() => outbind.close());
    const { port } = await outbind.listen(0, '127.0.0.1');
    const sessions: SmppClient[] = [];
    outbind.on('session', (client) => sessions.push(client));
    const rejected: string[] = [];
    outbind.on('rejected', (reason) => rejected.push(reason));

    const socket = tls.connect({ host: '127.0.0.1', port, ca: cert, servername: 'localhost' });
    cleanups.push(async () => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    const framer = new Framer();
    const received: Pdu[] = [];
    socket.on('data', (chunk) => {
      for (const f of framer.push(chunk).frames) {
        const pdu = decodePdu(f);
        received.push(pdu);
        if (pdu.command === 'bind_receiver')
          socket.write(
            encodePdu({
              command: 'bind_receiver_resp',
              sequence_number: pdu.sequence_number,
              system_id: 'SMSC',
            }),
          );
      }
    });
    socket.write(encodePdu({ command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' }));
    await until(() => sessions.length === 1);
    expect(sessions[0]?.state).toBe('BOUND_RX');

    // Plain TCP on the TLS port: no handshake, closed after handshakeTimeout.
    const plain = await connectAsSmsc(port, [
      { command: 'outbind', sequence_number: 1, system_id: 'smsc', password: 'pw' },
    ]);
    await plain.closed;
    await until(() => rejected.length === 1);
    expect(rejected).toEqual(['tls']);
  });
});
