/**
 * OpenTelemetry adapter (`smpp-ts/otel`).
 *
 * No dependency: the types below describe the subset of the `@opentelemetry/api` `Meter`
 * API in use, which the application provides itself.
 *
 * ```ts
 * import { metrics } from '@opentelemetry/api';
 * import { instrumentSmpp } from 'smpp-ts/otel';
 *
 * const detach = instrumentSmpp(client, metrics.getMeter('sms-gateway'));
 * ```
 */
import type { Metric } from '../metrics.js';

export type OtelAttributes = Record<string, string | number | boolean>;

export interface OtelInstrumentOptions {
  description?: string;
  unit?: string;
}

export interface OtelMeterLike {
  createCounter(
    name: string,
    options?: OtelInstrumentOptions,
  ): { add(value: number, attributes?: OtelAttributes): void };
  createHistogram(
    name: string,
    options?: OtelInstrumentOptions,
  ): { record(value: number, attributes?: OtelAttributes): void };
  createUpDownCounter(
    name: string,
    options?: OtelInstrumentOptions,
  ): { add(value: number, attributes?: OtelAttributes): void };
  /** Synchronous gauge (`@opentelemetry/api` ≥ 1.9). An UpDownCounter is used otherwise. */
  createGauge?(
    name: string,
    options?: OtelInstrumentOptions,
  ): { record(value: number, attributes?: OtelAttributes): void };
}

/** Any emitter of `metric` events: `SmppClient`, `SmppServer`, `Session`. */
export interface MetricSource {
  on(event: 'metric', listener: (metric: Metric, ...rest: never[]) => void): unknown;
  off(event: 'metric', listener: (metric: Metric, ...rest: never[]) => void): unknown;
}

export interface InstrumentOptions {
  /** Instrument name prefix. Default: `smpp`. */
  prefix?: string;
  /** Attributes added to every measurement (e.g. `{ 'smpp.operator': 'orange-ci' }`). */
  attributes?: OtelAttributes;
}

const DESCRIPTIONS: Record<Metric['name'], OtelInstrumentOptions> = {
  'pdu.sent': { description: 'PDUs written to the socket', unit: '{pdu}' },
  'pdu.received': { description: 'PDUs read from the socket', unit: '{pdu}' },
  'request.latency': { description: 'Time between a request and its response', unit: 'ms' },
  'request.timeout': { description: 'Requests that timed out', unit: '{request}' },
  'request.inflight': { description: 'Requests awaiting a response', unit: '{request}' },
  'queue.size': { description: 'Requests waiting in the send queue', unit: '{request}' },
  'session.reconnect': { description: 'Reconnection attempts', unit: '{attempt}' },
  command_status: { description: 'Responses by command_status', unit: '{response}' },
  'bytes.in': { description: 'Bytes received', unit: 'By' },
  'bytes.out': { description: 'Bytes sent', unit: 'By' },
};

type Recorder = (value: number, attributes: OtelAttributes) => void;

/**
 * Forwards the metrics of a client, server or session to an OpenTelemetry `Meter`.
 * On the server side, every measurement carries the session's `smpp.system_id` attribute.
 * Returns a function that detaches the adapter.
 */
export function instrumentSmpp(
  source: MetricSource,
  meter: OtelMeterLike,
  options: InstrumentOptions = {},
): () => void {
  const prefix = options.prefix ?? 'smpp';
  const base = options.attributes ?? {};
  const recorders = new Map<string, Recorder>();
  /** Last value per gauge and attribute set (UpDownCounter fallback). */
  const lastGaugeValues = new Map<string, number>();

  const recorderFor = (metric: Metric): Recorder => {
    let recorder = recorders.get(metric.name);
    if (recorder) return recorder;
    const name = `${prefix}.${metric.name}`;
    const opts = DESCRIPTIONS[metric.name];
    if (metric.type === 'counter') {
      const counter = meter.createCounter(name, opts);
      recorder = (v, a) => counter.add(v, a);
    } else if (metric.type === 'histogram') {
      const histogram = meter.createHistogram(name, opts);
      recorder = (v, a) => histogram.record(v, a);
    } else if (meter.createGauge) {
      const gauge = meter.createGauge(name, opts);
      recorder = (v, a) => gauge.record(v, a);
    } else {
      const upDown = meter.createUpDownCounter(name, opts);
      recorder = (v, a) => {
        const key = `${name}|${JSON.stringify(a)}`;
        const delta = v - (lastGaugeValues.get(key) ?? 0);
        lastGaugeValues.set(key, v);
        if (delta !== 0) upDown.add(delta, a);
      };
    }
    recorders.set(metric.name, recorder);
    return recorder;
  };

  const listener = (metric: Metric, ...rest: unknown[]): void => {
    try {
      const attributes: OtelAttributes = { ...base };
      if (metric.labels) {
        attributes['smpp.command'] = metric.labels.command;
        if ('status' in metric.labels) attributes['smpp.command_status'] = metric.labels.status;
      }
      const session = rest[0] as { systemId?: string } | undefined;
      if (session?.systemId) attributes['smpp.system_id'] = session.systemId;
      recorderFor(metric)(metric.value, attributes);
    } catch {
      // A telemetry SDK error must never disturb SMPP traffic.
    }
  };

  source.on('metric', listener);
  return () => {
    source.off('metric', listener);
  };
}
