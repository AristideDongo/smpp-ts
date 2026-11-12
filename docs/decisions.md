---
title: Design decisions
---

# Design decisions

The choices that shape the library, and why. Each one is enforced by tests; changing one is a breaking change.

## Safe by default

**Decision.** Every protection is on unless the application turns it off: TLS certificates are verified (TLS 1.2 minimum), the server refuses every bind without an `authenticate()` hook, passwords never reach a log, sessions, queues, reassembly buffers and unanswered incoming PDUs are bounded.

**Why.** An SMPP link carries credentials and personal data. A default that is unsafe stays unsafe in production, because nobody revisits it once it works.

## Never lose a message silently, never send one twice

**Decision.** Every request ends with a response, an error or a timeout. Errors carry `written`: whether the PDU left. The library resends on its own only what never left (queued messages after a reconnection, a pool member that could not send); a message that may have been accepted is never resent automatically.

**Why.** A duplicate OTP or a double-billed campaign is worse than an error the application can see and decide on.

## Promises and typed errors

**Decision.** Every call returns a Promise that rejects with an `SmppError` subclass (`SmppStatusError`, `SmppTimeoutError`, `SmppConnectionClosedError`…). An `error` event nobody listens to is logged, never thrown.

**Why.** `try` / `catch` with `instanceof` is what TypeScript applications already use; an unhandled `error` event must not end the process of an SMS gateway.

## The protocol is data

**Decision.** Commands, fields, TLVs and status codes are declared in one table (`src/protocol/`), from which the codec and the PDU types are derived. Field names are the ones of the SMPP specification.

**Why.** The specification can be read side by side with the code, and a new TLV is one line.

## The parser never crashes

**Decision.** Every read is bounded by the PDU and by the field's maximum length. An invalid PDU gets a `generic_nack` and the session goes on; only a stream that cannot be resynchronized is closed. The parser runs a million random inputs in CI.

**Why.** Network input is untrusted, and one malformed PDU from one peer must not take down a server.

## Zero runtime dependencies

**Decision.** Only Node's standard API at runtime; storage (tracking, deduplication, sequence numbers) and OpenTelemetry are interfaces the application implements.

**Why.** Supply chain risk, install size and runtime portability (Node, Bun, Deno). Third-party implementations are tested through Docker images and binaries in CI, never as dependencies.

## Cost and priority are the library's job

**Decision.** `sendText` picks the most compact encoding, can normalize a text to stay in GSM7 when that saves segments, and orders its queue by priority.

**Why.** Every segment is billed, and a one-time code waiting behind a campaign is a failed login. These are SMPP concerns every application would otherwise reimplement.
