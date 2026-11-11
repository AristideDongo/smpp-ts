# smpp-ts

## 0.5.0

### Minor Changes

- 59eb678: Server: safer authentication and handler cancellation.

  - `authenticate()` binds the session only when it returns `true` or an object. `0`, `''`, `NaN` and any other value are refusals (#23).
  - Only refusals by `authenticate()` count toward the IP ban. A session limit answers `ESME_RBINDFAIL` without counting; a timeout or exception in `authenticate()` answers `ESME_RSYSERR` without counting. `bindFailed` carries a `reason`: `credentials`, `limit`, `timeout` or `error` (#24).
  - Handlers receive a third argument `{ signal }`, and `authenticate()` a `signal` field: aborted when `handlerTimeout` expires or the session closes, so late work can be rolled back instead of duplicating a message (#25).

## 0.4.0

### Minor Changes

- 54ffa30: `SmppPool`: several binds behind the `SmppClient` API.

  - `size` identical binds, or `members` with per-bind options (another host, another `system_id`…).
  - `least-busy` (default) or `round-robin` strategy; `minBound` binds required by `connect()`.
  - Failover: sends go through the other binds while one reconnects. A send that was not written moves to another bind; a written one is never resent.
  - Receipts (`messageStatus`) and multipart incoming messages work whatever bind they arrive on. Concatenation references are shared, so two binds never use the same one at the same time.
  - Events `memberUp` and `memberDown`.

  `InboundProcessor` (receipt and incoming message handling, reassembly) is exported for advanced use.

- ffe678c: Pluggable storage interfaces (no storage shipped: the application implements them).

  - `trackDeliveries: { store }`: a `DeliveryTrackerStore` (`save`, `delete`, `load`) receives every change of the tracked messages. A client reloads it before its first bind, so tracking survives a restart. `DeliveryTracker.restore()` for standalone use. Store errors are logged and tracking goes on in memory.
  - `sequenceGenerator: { next() }`: source of `sequence_number` values.
  - `concatReference: () => number`: source of long-message concatenation references (client and pool).

- c06ab92: - `connect({ signal })` on `SmppClient` and `SmppPool`: aborts the TCP/TLS connection or the bind with `SmppAbortError`.
  - Published on JSR as `@smpp-ts/smpp-ts` (`deno add jsr:@smpp-ts/smpp-ts`). `jsr.json` follows the npm version.
  - Explicit return types on `query`, `cancel`, `replace`, `defaultCodec`, `encodings` and `SmppServer.sessions`.
- bcea670: Command line `smpp-ts` (`npx smpp-ts …`), with no dependency:

  - `smpp-ts smsc`: SMSC simulator (credentials, receipts `delivered` / `undeliverable` / `random` / `none` with a delay, `--echo` MO, TLS). Listens on 127.0.0.1 by default.
  - `smpp-ts send`: sends an SMS, prints the message ids, and with `--dlr` waits for the final receipt (exit code 0 if delivered). `--ca` trusts a self-signed certificate without disabling verification.

- 5df16f0: GSM7: every national language table of 3GPP TS 23.038 (Release 9+).

  - 13 single shift tables (UDH IE 0x24): Turkish, Spanish, Portuguese, Bengali, Gujarati, Hindi, Kannada, Malayalam, Oriya, Punjabi, Tamil, Telugu, Urdu.
  - 12 locking shift tables (UDH IE 0x25, all but Spanish): 1 septet per national character. A Hindi text goes in 152 characters per SMS instead of 70 in UCS2.
  - Detection (`shiftTables`) tries the single shift table alone, then locking + single. `shift` / `locking` force them. Incoming messages announcing a locking table are decoded.
  - New exports: `NATIONAL_LANGUAGES`, `NATIONAL_LANGUAGE_ID`, `hasLockingShift`, types `Gsm7Tables` / `Gsm7Shift`. `encodeGsm7` / `decodeGsm7` / `canEncodeGsm7` accept `{ single, locking }`; a plain language code keeps meaning the single shift table.

- 4f41793: Server hardening:

  - Reading pauses while a session's write buffer is full, and a session is closed beyond `maxWriteBuffer` (1 MiB by default): a peer that never reads its responses can no longer grow memory, even before bind (#6).
  - Inbound window: at most `inboundWindow` (10) handlers run at the same time per session. `inboundWindowPolicy` chooses between pausing reading (`pause`, default) and answering `ESME_RTHROTTLED` (`throttle`) (#7).
  - `maxSessions` and `maxSessionsPerIp` count connections from the moment they are accepted, PROXY header and TLS handshake included. New `handshakeTimeout` (10 s) for the TLS handshake, which used `bindTimeout` (30 s) until now (#8).
  - `maxSessionsPerSystemId` can no longer be exceeded by concurrent binds: the slot is reserved before `authenticate()` (#9).
  - A handler that returns fields that cannot be encoded gets `ESME_RSYSERR` instead of leaving the request unanswered.

  Client:

  - `AbortSignal` on every request (`signal` option) and on `sendText`. New `SmppAbortError` with `written`.
  - `multipart.maxSegments` and the per-call `maxSegments` option cap the segments of a `sendText`.
  - `flash: true` in `sendText` sends a flash SMS (message class 0).

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
