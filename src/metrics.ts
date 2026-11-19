/** Metric emitted through the `metric` event. */
export type Metric =
  | { name: 'pdu.sent' | 'pdu.received'; type: 'counter'; value: number; labels: { command: string } }
  | { name: 'request.latency'; type: 'histogram'; value: number; labels: { command: string } }
  | { name: 'request.timeout'; type: 'counter'; value: number; labels: { command: string } }
  | { name: 'request.inflight' | 'queue.size'; type: 'gauge'; value: number; labels?: undefined }
  /** Time a request waited in the send queue before being written. */
  | { name: 'request.queueWait'; type: 'histogram'; value: number; labels: { command: string } }
  /** Round trip of the keepalive: the SMSC's response time, traffic aside. */
  | { name: 'session.rtt'; type: 'histogram'; value: number; labels?: undefined }
  /** Incomplete multipart messages held, and the octets they hold. */
  | { name: 'reassembly.buffers' | 'reassembly.bytes'; type: 'gauge'; value: number; labels?: undefined }
  /** Messages awaiting their delivery receipts (`trackDeliveries`). */
  | { name: 'tracker.size'; type: 'gauge'; value: number; labels?: undefined }
  | { name: 'session.reconnect'; type: 'counter'; value: number; labels?: undefined }
  /** SMPP 5.0 `congestion_state` (0-100) reported by the peer in its responses. */
  | { name: 'session.congestion'; type: 'gauge'; value: number; labels?: undefined }
  /** A receipt or message already processed was received again and dropped. */
  | { name: 'inbound.duplicate'; type: 'counter'; value: number; labels: { kind: string } }
  | { name: 'command_status'; type: 'counter'; value: number; labels: { command: string; status: string } }
  | { name: 'bytes.in' | 'bytes.out'; type: 'counter'; value: number; labels?: undefined };

export type MetricName = Metric['name'];

/**
 * Rate limiter for gauges: a gauge is a snapshot, not an event, so emitting one per request only
 * creates garbage for the collector to throw away. A value of 0 always goes through, so the last
 * state an application sees is never a stale non-zero one.
 */
export class GaugeSampler {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly intervalMs = 50,
    private readonly now: () => number = () => Date.now(),
  ) {}

  shouldEmit(name: string, value: number): boolean {
    const t = this.now();
    const previous = this.last.get(name);
    // No entry means this gauge has never been emitted: the first value always goes through.
    if (value !== 0 && this.intervalMs > 0 && previous !== undefined && t - previous < this.intervalMs) {
      return false;
    }
    this.last.set(name, t);
    return true;
  }
}
