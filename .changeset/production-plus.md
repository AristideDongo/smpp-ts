---
"smpp-ts": minor
---

Lower SMS cost, urgent traffic first, no duplicate receipts, and a test SMSC.

- **GSM7 normalization**: `normalize: 'punctuation' | 'transliterate'` (client option or per `sendText`) replaces curly quotes, dashes, special spaces, invisible characters and, in `transliterate` mode, letters missing from GSM7 (`ô` → `o`, `œ` → `oe`), only when it saves segments. `sendText` returns `replacements`. New exports `normalizeForGsm7`, `nonGsm7Characters`, `prepareText`.
- **Cost estimate**: `client.estimate({ text })` / `pool.estimate()` / `estimateText()` give the encoding, segments, the characters that force UCS2 and the normalization that would save segments (`suggestion`).
- **Priority queue**: `priority` (0-3) in `sendText` and `{ priority }` on any request (default: the request's `priority_flag`) order the send queue; a starvation guard (`queueFairness`, 10 by default, 0 = strict) keeps lower priorities moving. `RequestQueue` takes `{ maxSize, fairness }` (a number still works).
- **Deduplication**: receipts with the same `message_id` and status are dropped by default (`dedup.receipts`); identical incoming messages too with `dedup: { messages: true }`. New `duplicate` event and `inbound.duplicate` metric; pluggable `DedupStore`, `MemoryDedupStore`. Shared by the binds of a pool. `dedup: false` restores the previous behaviour.
- **Health**: `client.health()` and `pool.health()` for readiness probes.
- **Credential rotation**: `updateBind()` changes the bind parameters for the next bind; `rebind()` re-binds now without losing queued or in-flight requests. `pool.rebind()` re-binds one member at a time.
- **SMPP 5.0 congestion**: the `congestion_state` TLV of responses slows the rate limiter down from `congestionThreshold` (90 by default); `session.congestion` metric and `health().congestionState`.
- **`smpp-ts/testing`**: `createTestSmsc()` starts an in-process SMSC that records traffic, sends receipts and MOs, and injects failures (`throttleNext`, `failNext`, `dropNext`, `delayNext`, `disconnectOnNext`, `disconnectAll`, `setCongestion`, `duplicateReceipts`).
- The build shares chunks between `smpp-ts`, `smpp-ts/otel` and `smpp-ts/testing`: `instanceof` works across entry points.
