# smpp-ts

## 1.0.0

### Major Changes

- **1.0.0: stable API.** From this release, the public API (everything exported by `smpp-ts`, `smpp-ts/otel` and `smpp-ts/testing`, the option names and defaults, the events and their arguments, the error classes and their fields) follows semantic versioning: a breaking change waits for 2.0.

  The v1 acceptance criteria of the specification are met: every bug of the original analysis has a regression test, the security and reliability requirements are implemented and tested, the parser runs one million fuzzing iterations without an uncaught exception, coverage is above 90% on `codec/`, `encoding/` and `session/`, the package has no runtime dependency, and no password reaches a log.

  Behaviour to check when upgrading from 0.5.0:

  - A receipt with the same `message_id` and status as one already received is dropped (`duplicate` event instead of a second `deliveryReport` / `messageStatus`). `dedup: false` restores the previous behaviour.
  - `RequestQueue` serves higher priorities first. Requests without `priority` (or `priority_flag`) keep their FIFO order.

### Minor Changes

- #34: Faster client, bounded manual acknowledgement, three more interoperability peers.

  - **`maxPendingInbound`** (1,000 by default): with `autoAck: false`, incoming `deliver_sm` / `data_sm` waiting for `respond()` are bounded per session; beyond, they are answered at once with `ESME_RX_T_APPN` (the SMSC delivers them again later) and not emitted. `client.pendingInboundCount`, `pool.respond(pdu)` and `pool.pendingInboundCount`.
  - **`respond()` answers on the session the PDU arrived on.** After a reconnection, answering a PDU of the old session no longer sends a response with a stale `sequence_number` on the new one (it could acknowledge another message).
  - **Throughput**: the writes of one batch leave in one system call (`cork` / `uncork`), the send queue is O(1), TLV encoding looks only at the parameters given. Against an SMSC in another process: about 60,000 `submit_sm`/s at window 10 and 90,000 at window 100 on a 2017 laptop CPU (2.3 to 3 times the previous release); `submit_sm` encoding 3.5 times faster. Bytes on the wire are unchanged.
  - `DeliveryTrackerStore.save` / `delete` may return any value (a Redis or SQL call can be returned as it is); a rejected Promise is still logged.
  - Interoperability tested in CI against Kannel 1.4.5 (smpp-ts server, via `sendsms`, `dlr-url` and `get-url`), Cloudhopper SMPP 5.0.9 (smpp-ts client) and php8-smpp 0.1.1 (smpp-ts server), on top of Jasmin, smscsim, jsmpp, python-smpplib and gosmpp.
  - Every TypeScript example of the README and the guides is type-checked against the API in the test suite.
  - New guides: migration plan, design decisions.

- 0179c62: Lower SMS cost, urgent traffic first, no duplicate receipts, and a test SMSC.

  - **GSM7 normalization**: `normalize: 'punctuation' | 'transliterate'` (client option or per `sendText`) replaces curly quotes, dashes, special spaces, invisible characters and, in `transliterate` mode, letters missing from GSM7 (`ô` → `o`, `œ` → `oe`), only when it saves segments. `sendText` returns `replacements`. New exports `normalizeForGsm7`, `nonGsm7Characters`, `prepareText`.
  - **Cost estimate**: `client.estimate({ text })` / `pool.estimate()` / `estimateText()` give the encoding, segments, the characters that force UCS2 and the normalization that would save segments (`suggestion`).
  - **Priority queue**: `priority` (0-3) in `sendText` and `{ priority }` on any request (default: the request's `priority_flag`) order the send queue; a starvation guard (`queueFairness`, 10 by default, 0 = strict) keeps lower priorities moving. `RequestQueue` takes `{ maxSize, fairness }` (a number still works).
  - **Deduplication**: receipts with the same `message_id` and status are dropped by default (`dedup.receipts`); identical incoming messages too with `dedup: { messages: true }`. New `duplicate` event and `inbound.duplicate` metric; pluggable `DedupStore`, `MemoryDedupStore`. Shared by the binds of a pool. `dedup: false` restores the previous behaviour.
  - **Health**: `client.health()` and `pool.health()` for readiness probes.
  - **Credential rotation**: `updateBind()` changes the bind parameters for the next bind; `rebind()` re-binds now without losing queued or in-flight requests. `pool.rebind()` re-binds one member at a time.
  - **SMPP 5.0 congestion**: the `congestion_state` TLV of responses slows the rate limiter down from `congestionThreshold` (90 by default); `session.congestion` metric and `health().congestionState`.
  - **`smpp-ts/testing`**: `createTestSmsc()` starts an in-process SMSC that records traffic, sends receipts and MOs, and injects failures (`throttleNext`, `failNext`, `dropNext`, `delayNext`, `disconnectOnNext`, `disconnectAll`, `setCongestion`, `duplicateReceipts`).
  - The build shares chunks between `smpp-ts`, `smpp-ts/otel` and `smpp-ts/testing`: `instanceof` works across entry points.

### Patch Changes

- 91b2d1e: Server: in-flight handlers and `authenticate()` share one `close` listener per session to drive their `AbortSignal`. With the default `inboundWindow` of 10, Node no longer prints `MaxListenersExceededWarning` on every burst of requests.

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
