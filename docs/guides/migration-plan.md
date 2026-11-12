---
title: Migration plan
---

# Migration plan

How to move an application that already sends SMS over SMPP to `smpp-ts`, whatever library it uses today, without losing a message or sending one twice. For the API itself (callbacks to Promises, option names), see [MIGRATION.md](../../MIGRATION.md).

## 1. Inventory

Before touching code, write down what the current integration really does:

| Question | Where it lands in smpp-ts |
|---|---|
| SMSC host, port, TLS, certificate (self-signed?) | `url` (`smpp://` / `ssmpp://`), `tls: { ca }` |
| Bind mode, `system_id`, `system_type`, interface version | `bind` |
| Number of binds allowed, throughput per bind | `SmppPool` (`size` or `members`), `rateLimit` |
| Keepalive period, timeouts | `enquireLinkInterval`, `enquireLinkTimeout`, `requestTimeout` |
| How long messages are sent (8-bit UDH, 16-bit UDH, SAR TLVs, `message_payload`) | `multipart.strategy` |
| Message id format of the SMSC (decimal in `submit_sm_resp`, hex in receipts?) | `messageIdFormat` |
| What the code does with receipts and incoming messages | `deliveryReport`, `messageStatus`, `message` |
| What it does on errors: retries, resends, alerts | typed errors, `retry`, `written` (step 3) |
| Logs: are passwords or SMS contents written today? | masked by default; `redactContent`, `redactNumbers` |

## 2. Map the code

| Usually | With smpp-ts |
|---|---|
| A callback, or a `{ err, … }` result per send | `await client.sendText(…)`; failures reject with typed errors |
| Splitting long texts and choosing the encoding by hand | `sendText` does both and returns one id per segment |
| Gluing segment receipts together by hand | `trackDeliveries: true` → one `messageStatus` per message |
| Reassembling incoming segments by hand | `message` is emitted once the whole message arrived |
| Home-made reconnection and keepalive | built in (`reconnect`, dead link detection) |
| Home-made throttling | `rateLimit` (slows down on `ESME_RTHROTTLED` and SMPP 5.0 congestion) |
| Server that accepts every bind | `authenticate()` is required |

## 3. Decide what to do on errors

The most common source of duplicates in a migration is resending after an ambiguous failure. Every error says whether the PDU left:

| Error | `written` | Action |
|---|---|---|
| `SmppConnectionClosedError`, `SmppAbortError`, `SmppQueueFullError` | `false` | Never left: resend safely |
| `SmppConnectionClosedError`, `SmppTimeoutError` | `true` | The SMSC may have accepted it: wait for the receipt, never resend blindly |
| `SmppStatusError`, `category: 'permanent'` | — | Mark as failed |
| `SmppStatusError`, `category: 'temporary'` | — | Already retried with backoff (`retry`) |

The library never resends on its own a message that may have been accepted.

## 4. Test before the SMSC

Write the tests against `smpp-ts/testing` (an SMSC in the test process): the normal path, then the failures the old code handled, or should have.

```ts
import { createTestSmsc } from 'smpp-ts/testing';

const smsc = await createTestSmsc({ receipts: 'DELIVERED' });
smsc.throttleNext(2);              // the old throttling logic is no longer needed: check the send still succeeds
smsc.dropNext('submit_sm');        // lost response: check the application does not resend
smsc.disconnectOnNext('submit_sm'); // connection cut in flight: check the reconnection and what is reported
```

See [Testing an application that sends SMS](testing.md).

## 5. Check against the operator's test SMSC

Run the interoperability suite against the operator's test account (`npm run test:interop`, [instructions](../../test/interop/README.md)), then send by hand to a test phone: GSM7, accents, an emoji, a message longer than 160 characters (it must show up as one message on the phone), and check that receipts match their message ids.

## 6. Cut over gradually

1. **One bind first.** If the operator allows several binds, give one to smpp-ts and keep the others on the old code. Compare delivery rates and latency (`metric` events, or `smpp-ts/otel`).
2. **Watch** `command_status` per code, `request.timeout`, `session.reconnect`, `inbound.duplicate` and the `DELIVERED` rate of `messageStatus` ([Going to production](../PRODUCTION.md)).
3. **Move the remaining binds** once the figures match, one at a time. Receipts may arrive on any bind: run receipt handling in smpp-ts for every bind as soon as it sends (an `SmppPool` handles them for all its binds).
4. **Stop the old code** with a clean unbind, after its last receipts arrived.

## 7. Rollback

Keep the old integration deployable until the end of step 6. Messages are never lost in the switch as long as each side finishes cleanly: `client.close({ drain: true })` waits for requests in flight and unbinds, and messages still queued are rejected with `written: false` (safe to send through the other side).
