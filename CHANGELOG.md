# smpp-ts

## 0.2.0

### Minor Changes

- 7438d09: `sendText` normalizes and validates addresses: separators are stripped (`+225 07 00…`), the `00` prefix becomes TON international, alphanumeric senders are limited to 11 GSM characters and international numbers to 15 digits. The `address` option adjusts or disables this. Errors are thrown before anything is sent (`SmppValidationError`).
- 7438d09: Multipart delivery tracking: `trackDeliveries` option and `messageStatus` event (`DELIVERED`, `FAILED`, `PARTIALLY_DELIVERED`, `TIMEOUT`), with an application `reference`. The `DeliveryTracker` class is exported for standalone use. Bounded memory (`maxTracked`, `ttl`).
- 7438d09: OpenTelemetry adapter `smpp-ts/otel`: `instrumentSmpp(clientOrServer, meter)` forwards metrics to an OpenTelemetry `Meter` (counters, latency histogram, gauges, `smpp.system_id` attribute on the server side). No dependency: the application provides the `Meter`.

### Patch Changes

- 7438d09: Bun and Deno compatibility checked in CI by a smoke test on the built package (`test/runtime/smoke.mjs`). New interoperability suite `npm run test:interop`, runnable against a simulated SMSC (Docker) or an operator's test SMSC.
- Documentation and code comments are now in English.

## 0.1.0

First public release.

- SMPP v3.4 / v5.0 client (`SmppClient`) and server (`SmppServer`).
- Typed codec derived from a declarative table of commands, TLVs and status codes; custom TLVs.
- GSM7 (Turkish, Spanish and Portuguese shift tables), Latin-1 and UCS2 encodings; automatic detection.
- Long messages (`udh8`, `udh16`, `sar`, `payload`) and bounded reassembly of incoming messages.
- Delivery receipts: lenient parser, TLVs take precedence, normalized statuses and `message_id`s.
- Reliability: state machine, timeouts on every operation, send window, bounded queue, adaptive rate limiting, keepalive with dead connection detection, reconnection with re-bind, retries on temporary errors, graceful shutdown.
- Security: TLS verified by default (TLS 1.2 minimum), secrets never logged, strict validation, mandatory server authentication, resource limits, Proxy Protocol v1/v2 with trusted proxies.
- No runtime dependencies.
