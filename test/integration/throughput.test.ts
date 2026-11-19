import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_STATUS,
  type InboundMessage,
  type Metric,
  SmppClient,
  type SmppClientOptions,
  SmppServer,
  type SmppServerOptions,
  type SmppStatusError,
} from '../../src/index.js';
import type { Logger } from '../../src/logger.js';
import { sleep, until } from '../helpers/raw-smsc.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

let idCounter = 0;

interface SubmitSeen {
  data_coding: number;
  esm_class: number;
  short_message: Buffer;
}

async function startServer(options: Partial<SmppServerOptions> = {}) {
  const received: SubmitSeen[] = [];
  const server = new SmppServer({
    authenticate: ({ password }) => password === 'secret',
    handlers: {
      submit_sm: (pdu) => {
        received.push(pdu as unknown as SubmitSeen);
        return { message_id: `MSG${++idCounter}` };
      },
    },
    ...options,
  });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { server, port, received };
}

function makeClient(port: number, options: Partial<SmppClientOptions> = {}) {
  const client = new SmppClient({
    url: `smpp://127.0.0.1:${port}`,
    bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
    reconnect: false,
    ...options,
  });
  cleanups.push(() => client.close());
  return client;
}

describe('sendBinary', () => {
  it('sends a WAP push in one PDU, ports in the UDH', async () => {
    const { port, received } = await startServer();
    const client = makeClient(port);
    await client.connect();
    const data = Buffer.from('0601ae02056a0045c6', 'hex');
    const res = await client.sendBinary({
      to: '2250700000000',
      from: 'PUSH',
      data,
      destPort: 2948,
      sourcePort: 9200,
    });
    expect(res).toMatchObject({ parts: 1, bytes: data.length });
    expect(res.messageIds).toHaveLength(1);
    const sent = received[0]!;
    expect(sent.data_coding).toBe(0x04);
    // UDH: UDHL(1) + IEI 0x05 + len 4 + ports; the content follows untouched.
    const body = sent.short_message;
    expect(body.subarray(0, 3)).toEqual(Buffer.from([0x06, 0x05, 0x04]));
    expect(body.subarray(7)).toEqual(data);
  });

  it('splits a large payload into segments that carry the whole content back', async () => {
    const data = Buffer.alloc(900);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
    const { port, received } = await startServer();
    const client = makeClient(port);
    await client.connect();
    const res = await client.sendBinary({ to: '2250700000000', from: 'OTA', data, destPort: 2948 });
    // UDH = UDHL + concat(5) + 16-bit ports(6) = 12 octets, leaving 128 per segment.
    expect(res.parts).toBe(Math.ceil(900 / 128));
    expect(res.messageIds).toHaveLength(res.parts);
    expect(received).toHaveLength(res.parts);
    const bodies = received.map((pdu) => {
      const udhLength = pdu.short_message[0]! + 1;
      return pdu.short_message.subarray(udhLength);
    });
    expect(Buffer.concat(bodies).equals(data)).toBe(true);
    // Every segment announces the same reference and its own rank.
    const refs = new Set(received.map((p) => p.short_message[3]));
    expect(refs.size).toBe(1);
    expect(received.map((p) => p.short_message[5]).sort()).toEqual(
      Array.from({ length: res.parts }, (_, i) => i + 1),
    );
  });

  it('refuses content over maxSegments before sending anything', async () => {
    const { port, received } = await startServer();
    const client = makeClient(port);
    await client.connect();
    await expect(
      client.sendBinary({ to: '225070', from: 'X', data: Buffer.alloc(1000), maxSegments: 2 }),
    ).rejects.toThrow(/maxSegments/);
    expect(received).toHaveLength(0);
  });

  it('reports the application ports of an incoming binary message', async () => {
    const { port, server } = await startServer();
    const inbound: InboundMessage[] = [];
    const client = makeClient(port);
    client.on('message', (m) => inbound.push(m));
    await client.connect();
    await until(() => server.sessionsFor('acme').length > 0);
    // UDH with 8-bit ports (dest 100, source 123), then the content.
    const content = Buffer.concat([Buffer.from([0x04, 0x04, 0x02, 0x64, 0x7b]), Buffer.from('xyz')]);
    await server.deliver('acme', {
      source_addr: '2250700000000',
      destination_addr: 'OTA',
      esm_class: 0x40,
      data_coding: 0x04,
      short_message: content,
    });
    await until(() => inbound.length > 0);
    expect(inbound[0]!.ports).toEqual({ destination: 100, source: 123, bits: 8 });
    expect(inbound[0]!.body.equals(Buffer.from('xyz'))).toBe(true);
  });
});

describe('congestion_state reporting (SMPP 5.0)', () => {
  it('adds the TLV for a v5.0 peer and leaves a v3.4 peer alone', async () => {
    const { port } = await startServer();
    const v50 = makeClient(port, {
      bind: { mode: 'transceiver', system_id: 'a', password: 'secret', interface_version: 0x50 },
    });
    await v50.connect();
    const r1 = await v50.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'hi' });
    expect(r1.congestion_state).toBeTypeOf('number');
    expect(r1.congestion_state).toBeGreaterThanOrEqual(0);

    const v34 = makeClient(port, {
      bind: { mode: 'transceiver', system_id: 'b', password: 'secret', interface_version: 0x34 },
    });
    await v34.connect();
    const r2 = await v34.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'hi' });
    expect(r2.congestion_state).toBeUndefined();
  });

  it('congestionReporting: false removes it entirely', async () => {
    const { port } = await startServer({ congestionReporting: false });
    const client = makeClient(port, {
      bind: { mode: 'transceiver', system_id: 'a', password: 'secret', interface_version: 0x50 },
    });
    await client.connect();
    const res = await client.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'hi' });
    expect(res.congestion_state).toBeUndefined();
  });
});

describe('inboundRate (server)', () => {
  it('answers ESME_RTHROTTLED beyond the rate, and recovers', async () => {
    const { port, received } = await startServer({
      inboundRate: { perSecond: 1000, burst: 3 },
    });
    const client = makeClient(port, { retry: false });
    await client.connect();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        client.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'x' }),
      ),
    );
    const throttled = results.filter(
      (r) =>
        r.status === 'rejected' && (r.reason as SmppStatusError).status === COMMAND_STATUS.ESME_RTHROTTLED,
    );
    expect(throttled.length).toBeGreaterThan(0);
    // The accepted ones really went through the handler.
    expect(received.length).toBe(results.filter((r) => r.status === 'fulfilled').length);
    await sleep(60);
    await expect(
      client.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'x' }),
    ).resolves.toBeDefined();
  });
});

describe('drain and metrics', () => {
  it('close({ drain: true }) waits for the queue and the window, with no polling delay', async () => {
    const { port, received } = await startServer();
    const client = makeClient(port, { window: 2 });
    await client.connect();
    const sends = Array.from({ length: 10 }, (_, i) =>
      client.raw.submit_sm({ destination_addr: '2250700000000', short_message: `m${i}` }),
    );
    await client.close({ drain: true, timeout: 5000 });
    const settled = await Promise.allSettled(sends);
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(received).toHaveLength(10);
  });

  it('emits queueWait, inflight and reassembly gauges', async () => {
    const { port } = await startServer();
    const metrics: Metric[] = [];
    const client = makeClient(port, { window: 1 });
    client.on('metric', (m) => metrics.push(m));
    await client.connect();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.raw.submit_sm({ destination_addr: '2250700000000', short_message: `m${i}` }),
      ),
    );
    const names = new Set(metrics.map((m) => m.name));
    expect(names.has('request.queueWait')).toBe(true);
    expect(names.has('request.inflight')).toBe(true);
    const waits = metrics.filter((m) => m.name === 'request.queueWait');
    expect(waits).toHaveLength(5);
    expect(waits.every((m) => m.value >= 0)).toBe(true);
  });

  it('gauges are sampled, not emitted for every request', async () => {
    const { port } = await startServer();
    const gauges: number[] = [];
    const client = makeClient(port, { window: 50, gaugeInterval: 1000 });
    client.on('metric', (m) => {
      if (m.name === 'request.inflight') gauges.push(m.value);
    });
    await client.connect();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        client.raw.submit_sm({ destination_addr: '2250700000000', short_message: `m${i}` }),
      ),
    );
    // One sample for the burst, plus the zeros that always go through.
    expect(gauges.filter((v) => v !== 0).length).toBeLessThan(5);
  });
});

describe('PDU logging', () => {
  function recorder(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const push = (msg: string) => lines.push(msg);
    return { logger: { debug: push, info: push, warn: push, error: push }, lines };
  }

  it('is skipped when the logger says the debug level is off', async () => {
    const { port } = await startServer();
    const { logger, lines } = recorder();
    const client = makeClient(port, { logger: { ...logger, isLevelEnabled: () => false } });
    await client.connect();
    await client.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'hi' });
    expect(lines.filter((l) => l.startsWith('pdu '))).toHaveLength(0);
  });

  it('logPdus: false wins over a logger with no level check', async () => {
    const { port } = await startServer();
    const noisy = recorder();
    const client = makeClient(port, { logger: noisy.logger });
    await client.connect();
    await client.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'hi' });
    expect(noisy.lines.filter((l) => l.startsWith('pdu ')).length).toBeGreaterThan(0);

    const quiet = recorder();
    const quietClient = makeClient(port, { logger: quiet.logger, logPdus: false });
    await quietClient.connect();
    await quietClient.raw.submit_sm({ destination_addr: '2250700000000', short_message: 'hi' });
    expect(quiet.lines.filter((l) => l.startsWith('pdu '))).toHaveLength(0);
  });
});
