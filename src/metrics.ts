/** Metric emitted through the `metric` event. */
export type Metric =
  | { name: 'pdu.sent' | 'pdu.received'; type: 'counter'; value: number; labels: { command: string } }
  | { name: 'request.latency'; type: 'histogram'; value: number; labels: { command: string } }
  | { name: 'request.timeout'; type: 'counter'; value: number; labels: { command: string } }
  | { name: 'request.inflight' | 'queue.size'; type: 'gauge'; value: number; labels?: undefined }
  | { name: 'session.reconnect'; type: 'counter'; value: number; labels?: undefined }
  /** SMPP 5.0 `congestion_state` (0-100) reported by the peer in its responses. */
  | { name: 'session.congestion'; type: 'gauge'; value: number; labels?: undefined }
  /** A receipt or message already processed was received again and dropped. */
  | { name: 'inbound.duplicate'; type: 'counter'; value: number; labels: { kind: string } }
  | { name: 'command_status'; type: 'counter'; value: number; labels: { command: string; status: string } }
  | { name: 'bytes.in' | 'bytes.out'; type: 'counter'; value: number; labels?: undefined };

export type MetricName = Metric['name'];
