---
'smpp-ts': minor
---

Throughput work and new features.

Performance (same machine, before → after):

- One shared min-heap timer for every deadline instead of one `setTimeout` per request and per tracked message (`TimeoutScheduler`, exported). Request timeouts and delivery tracking no longer allocate a timer each.
- `PduCodec.encode` reuses one scratch buffer, and `Writer.cstring` validates with a char-code loop instead of a regex: encode 431k → 519k ops/s.
- PDU debug logging is skipped entirely when the logger reports the `debug` level off (`Logger.isLevelEnabled`, forwarded by `pinoAdapter`), and responses are logged from the object already built instead of being decoded back. New `logPdus` option forces it either way.
- Gauge metrics (`queue.size`, `request.inflight`, the new inbound gauges) are sampled at most every 50 ms (`gaugeInterval`); a value of 0 always goes through.
- `Session.drain()` and `close({ drain: true })` resolve on the last response instead of polling every 10-20 ms.
- `submit_sm` against a sink: 97k → 148k msg/s (window 100). Client and server in one process: 41k → 47k msg/s (window 50).

Features:

- `client.sendBinary({ to, from, data, destPort, sourcePort, … })` and `pool.sendBinary` send binary content (WAP push, vCard, OTA configuration): concatenation and application ports (UDH IE 0x04/0x05) are built for you. `buildBinaryParts` does the splitting on its own. Incoming binary messages now report their ports as `msg.ports`.
- The server reports SMPP 5.0 `congestion_state` (0-100) in its responses to peers that announced `interface_version` 0x50, from the inbound window and session occupancy (`congestionReporting`).
- Server `inboundRate`: requests per second per session, on top of `inboundWindow`, answering `ESME_RTHROTTLED` at once beyond the rate.
- `SmppPool` gained the `failover` strategy and per-member `weight` (0 = standby).
- New metrics: `request.queueWait`, `session.rtt`, `reassembly.buffers`, `reassembly.bytes`, `tracker.size`, with their OpenTelemetry descriptions.
