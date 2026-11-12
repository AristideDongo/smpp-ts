# Going to production

This guide covers connecting `smpp-ts` to an operator's or aggregator's SMSC. Most production incidents do not come from code but from a setting that does not match what the SMSC expects, and every operator has its own rules. Ask them the questions below **before** writing the configuration.

## 1. Questions to ask the operator

| Question | `smpp-ts` option | If it is wrong |
|---|---|---|
| Host, port, TLS or not? | `url: 'smpp://…'` or `'ssmpp://…'` | Connection refused or timeout |
| TLS certificate signed by a public authority? | `tls: { ca }` if self-signed | `connect()` fails (verification is on by default) |
| `system_id`, `password`, `system_type`? | `bind` | `ESME_RBINDFAIL` |
| Bind mode: transmitter, receiver or transceiver? | `bind.mode` | No receipts, or `ESME_RINVBNDSTS` |
| SMPP version: 3.4 or 5.0? | `bind.interface_version` (default `0x34`) | Bind refused by some SMSCs |
| How many concurrent sessions? | Number of `SmppClient`s | Extra binds refused (`ESME_RALYBND`) |
| Allowed rate (SMS/s) per session? | `rateLimit: { perSecond }` | `ESME_RTHROTTLED` under bursts |
| Allowed window (unanswered requests)? | `window` (default 10) | `ESME_RTHROTTLED` or disconnection |
| Allowed senders: alphanumeric? numbers? registered in advance? | `from`, `address` | Message rejected or sender replaced |
| Expected TON/NPI for sender and recipient? | `sourceTon`, `destTon`… | `ESME_RINVSRCADR`, `ESME_RINVDSTADR` |
| Number format: international without `+`, national? | `address.internationalPrefix` | `ESME_RINVDSTADR` |
| Default encoding for `data_coding = 0`: GSM7, Latin-1? | `encodings` | Accents replaced with `?` |
| Long messages: UDH or SAR TLVs? | `multipart.strategy` | Segments shown separately on the phone |
| `message_id` format in receipts (hexadecimal, decimal)? | `messageIdFormat` | Receipts impossible to match |
| Expected `enquire_link` interval? | `enquireLinkInterval` (default 30 s) | Session dropped by the SMSC |
| Is a test SMSC available? | — | You are testing in production |

## 2. Typical configuration

```ts
import { readFileSync } from 'node:fs';
import { SmppClient, pinoAdapter } from 'smpp-ts';

const client = new SmppClient({
  url: process.env.SMPP_URL,                     // ssmpp://smsc.operator.example:3550
  tls: process.env.SMPP_CA ? { ca: readFileSync(process.env.SMPP_CA) } : undefined,
  bind: {
    mode: 'transceiver',
    system_id: process.env.SMPP_SYSTEM_ID!,
    password: process.env.SMPP_PASSWORD!,
  },
  window: 10,
  rateLimit: { perSecond: 50 },                  // the contractual rate, no more
  messageIdFormat: 'as-is',                      // 'hex-to-dec' if the operator requires it
  trackDeliveries: true,
  logger: pinoAdapter(logger),
  redactContent: true,                           // SMS content is personal data
  redactNumbers: true,
});
```

Credentials come from the environment or a secret store, never from the code. The password never appears in `smpp-ts` logs.

## 3. Sender (`from`)

- **Alphanumeric** (`MYSERVICE`): at most 11 characters, GSM alphabet. `smpp-ts` rejects anything longer, because networks truncate or reject it without a clear error. In many countries the sender must be registered with the operator in advance, otherwise it is replaced with a number or the message is blocked.
- **Number**: use the international format (`+225…`). The `+` is removed and TON is set to 1, as most SMSCs expect.
- **Short code** (`1234`): sent as is with TON 0. Some operators want TON 3 (network specific): `sourceTon: 3`.
- A `+` only makes sense for a number. Never add one to an alphanumeric sender.

## 4. Delivery receipts

1. Request them when sending: `registeredDelivery: true`.
2. Bind as `transceiver` (or open an extra `receiver` session), otherwise the SMSC has no session to deliver them to.
3. **Store every `messageId`** returned by `sendText` with your own message identifier, then match `deliveryReport` events by `messageId`. For a long SMS, `sendText` returns one `messageId` per segment.
4. With `trackDeliveries: true` and `reference`, the `messageStatus` event gives the outcome of the whole message directly.
5. If receipts never match, compare `dlr.rawMessageId` with `result.messageIds`: a hexadecimal/decimal mismatch is fixed with `messageIdFormat`.
6. Receipts sometimes arrive hours later (phone switched off). Persist state on the application side: built-in tracking lives in memory and is lost on restart.

`smpp-ts` automatically answers `deliver_sm_resp` to every incoming receipt and message. With `autoAck: false`, answer yourself with `client.respond(pdu)`, otherwise the SMSC will keep resending the same receipts.

## 5. Errors and resending

| Error | Meaning | Action |
|---|---|---|
| `SmppValidationError` | Nothing was sent (invalid address, text or parameter) | Fix the data, do not retry as is |
| `SmppStatusError`, `category: 'temporary'` | Already retried `retry.maxRetries` times | Requeue for later |
| `SmppStatusError`, `category: 'permanent'` | Final refusal (`ESME_RINVDSTADR`…) | Mark as failed |
| `SmppConnectionClosedError`, `written: false` | Never written to the socket | Safe to resend |
| `SmppConnectionClosedError` or `SmppTimeoutError`, `written: true` | The SMSC may have accepted it | Wait for the receipt, or check with `query()`, before resending |
| `SmppQueueFullError` | The local queue is full (slow or unreachable SMSC) | Slow the application down |
| `SmppMultipartError` | Only some segments were sent | `results` gives the detail per segment |

The library never resends on its own a message that may have been accepted, to avoid billed duplicates.

## 6. Clean shutdown

```ts
process.on('SIGTERM', async () => {
  await client.close({ drain: true, timeout: 15_000 });
  process.exit(0);
});
```

`drain` waits for pending sends, sends `unbind`, then closes. A hard stop leaves messages in the "may have been accepted" state.

## 7. Monitoring

At a minimum, watch through `client.on('metric')` or `smpp-ts/otel`:

- `request.latency`: a rise often precedes `ESME_RTHROTTLED`.
- `command_status` per code: a spike of `ESME_RTHROTTLED` means `rateLimit` is too high; a spike of `ESME_RINVDSTADR` points to a number format problem.
- `queue.size`: a growing queue means the SMSC cannot absorb the rate.
- `session.reconnect`: frequent reconnections often come from an `enquireLinkInterval` longer than the SMSC's idle timeout, or from a firewall that drops idle connections.
- `session.congestion`: an SMPP 5.0 SMSC reporting a high `congestion_state` (the client already slows down with `rateLimit`).
- `inbound.duplicate`: receipts or messages the SMSC sent again; a steady flow points to responses lost on the way back.
- `messageStatus` event: the `DELIVERED` rate per operator is the business metric.

`client.health()` (or `pool.health()`) gives a snapshot for a readiness probe: bound state, load, last traffic, congestion.

To rotate the bind password without a restart: `client.updateBind({ password })`, then `client.rebind()` (`pool.rebind()` re-binds one member at a time).

## 8. Before opening the traffic

1. Run the interoperability suite against the operator's test SMSC (see [test/interop/README.md](../test/interop/README.md)).
2. Send by hand, to a test phone: a GSM7 SMS, an SMS with accents, an SMS with an emoji, an SMS longer than 160 characters. Check that the long one shows up as **a single** message on the phone.
3. Check that receipts arrive and match their `messageId`.
4. Cut the network for a few minutes during a burst: the session must reconnect, and queued messages must go out after the re-bind.
5. Read the logs: no password, and no SMS content if `redactContent` is on.
