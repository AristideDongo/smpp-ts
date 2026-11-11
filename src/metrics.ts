/** Metric emitted through the `metric` event. */
export type Metric =
  | { name: 'pdu.sent' | 'pdu.received'; type: 'counter'; value: number; labels: { command: string } }
  | { name: 'request.latency'; type: 'histogram'; value: number; labels: { command: string } }
  | { name: 'request.timeout'; type: 'counter'; value: number; labels: { command: string } }
  | { name: 'request.inflight' | 'queue.size'; type: 'gauge'; value: number; labels?: undefined }
  | { name: 'session.reconnect'; type: 'counter'; value: number; labels?: undefined }
  | { name: 'command_status'; type: 'counter'; value: number; labels: { command: string; status: string } }
  | { name: 'bytes.in' | 'bytes.out'; type: 'counter'; value: number; labels?: undefined };

export type MetricName = Metric['name'];
