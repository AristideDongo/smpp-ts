import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { type Metric, SmppClient, SmppServer, safeCompare } from '../../src/index.js';
import { type OtelAttributes, type OtelMeterLike, instrumentSmpp } from '../../src/otel/index.js';

type Call = { instrument: string; kind: string; value: number; attributes: OtelAttributes | undefined };

function fakeMeter(withGauge = true) {
  const calls: Call[] = [];
  const created: Array<{ name: string; unit: string | undefined }> = [];
  const make = (kind: string, method: 'add' | 'record') => (name: string, options?: { unit?: string }) => {
    created.push({ name, unit: options?.unit });
    return {
      [method]: (value: number, attributes?: OtelAttributes) =>
        calls.push({ instrument: name, kind, value, attributes }),
    };
  };
  const meter = {
    createCounter: make('counter', 'add'),
    createHistogram: make('histogram', 'record'),
    createUpDownCounter: make('updown', 'add'),
    ...(withGauge ? { createGauge: make('gauge', 'record') } : {}),
  } as unknown as OtelMeterLike;
  return { meter, calls, created };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

describe('instrumentSmpp', () => {
  it('maps every metric type to the matching OTel instrument, created once', () => {
    const source = new EventEmitter<{ metric: [Metric] }>();
    const { meter, calls, created } = fakeMeter();
    instrumentSmpp(source, meter, { attributes: { 'smpp.operator': 'test' } });

    source.emit('metric', { name: 'pdu.sent', type: 'counter', value: 1, labels: { command: 'submit_sm' } });
    source.emit('metric', { name: 'pdu.sent', type: 'counter', value: 1, labels: { command: 'submit_sm' } });
    source.emit('metric', {
      name: 'request.latency',
      type: 'histogram',
      value: 12,
      labels: { command: 'submit_sm' },
    });
    source.emit('metric', { name: 'queue.size', type: 'gauge', value: 3 });
    source.emit('metric', {
      name: 'command_status',
      type: 'counter',
      value: 1,
      labels: { command: 'submit_sm_resp', status: 'ESME_RTHROTTLED' },
    });
    source.emit('metric', { name: 'bytes.out', type: 'counter', value: 42 });

    expect(created.map((c) => c.name)).toEqual([
      'smpp.pdu.sent',
      'smpp.request.latency',
      'smpp.queue.size',
      'smpp.command_status',
      'smpp.bytes.out',
    ]);
    expect(created.find((c) => c.name === 'smpp.bytes.out')?.unit).toBe('By');
    expect(calls[2]).toEqual({
      instrument: 'smpp.request.latency',
      kind: 'histogram',
      value: 12,
      attributes: { 'smpp.operator': 'test', 'smpp.command': 'submit_sm' },
    });
    expect(calls[3]).toMatchObject({ kind: 'gauge', value: 3 });
    expect(calls[4]?.attributes).toMatchObject({ 'smpp.command_status': 'ESME_RTHROTTLED' });
  });

  it('falls back to an UpDownCounter fed with deltas when createGauge is missing', () => {
    const source = new EventEmitter<{ metric: [Metric] }>();
    const { meter, calls } = fakeMeter(false);
    instrumentSmpp(source, meter, { prefix: 'sms' });
    for (const value of [2, 5, 5, 1])
      source.emit('metric', { name: 'request.inflight', type: 'gauge', value });
    expect(calls.map((c) => [c.instrument, c.kind, c.value])).toEqual([
      ['sms.request.inflight', 'updown', 2],
      ['sms.request.inflight', 'updown', 3],
      ['sms.request.inflight', 'updown', -4],
    ]);
  });

  it('detaches and never lets a telemetry error escape', () => {
    const source = new EventEmitter<{ metric: [Metric] }>();
    const meter = {
      createCounter: () => ({
        add: () => {
          throw new Error('exporter down');
        },
      }),
    } as unknown as OtelMeterLike;
    const detach = instrumentSmpp(source, meter);
    expect(() => source.emit('metric', { name: 'bytes.in', type: 'counter', value: 1 })).not.toThrow();
    detach();
    expect(source.listenerCount('metric')).toBe(0);
  });

  it('works with a real client and server, tagging server metrics with system_id', async () => {
    const server = new SmppServer({
      authenticate: ({ system_id, password }) => system_id === 'acme' && safeCompare(password, 'secret'),
      handlers: { submit_sm: () => ({ message_id: '1' }) },
    });
    const { port } = await server.listen(0, '127.0.0.1');
    cleanups.push(() => server.close());
    const client = new SmppClient({
      url: `smpp://127.0.0.1:${port}`,
      bind: { mode: 'transceiver', system_id: 'acme', password: 'secret' },
      reconnect: false,
    });
    cleanups.push(() => client.close());

    const clientMeter = fakeMeter();
    const serverMeter = fakeMeter();
    instrumentSmpp(client, clientMeter.meter);
    instrumentSmpp(server, serverMeter.meter);
    await client.connect();
    await client.sendText({ to: '+2250700000000', from: 'MISSOU', text: 'x' });

    expect(clientMeter.calls.some((c) => c.instrument === 'smpp.request.latency')).toBe(true);
    expect(serverMeter.calls.some((c) => c.attributes?.['smpp.system_id'] === 'acme')).toBe(true);
  });
});
