---
title: Troubleshooting
---

# Troubleshooting

The errors you will meet, what they mean and what to do. Every error the library throws is a
subclass of `SmppError` with a stable `code`; an SMSC refusal is a `SmppStatusError` carrying the
`command_status` (`status`), its name (`statusName`) and its category (`category`: `temporary`,
`permanent` or `session`).

```ts
import { SmppStatusError, SmppTimeoutError, SmppConnectionClosedError } from 'smpp-ts';

try {
  await client.sendText({ to, from, text });
} catch (err) {
  if (err instanceof SmppStatusError) console.log(err.statusName, err.category);
  else if (err instanceof SmppTimeoutError) console.log('no answer after', err.timeoutMs, 'ms');
  else if (err instanceof SmppConnectionClosedError) console.log('written to the socket:', err.written);
}
```

## Connecting and binding

| Symptom | Likely cause | What to do |
|---|---|---|
| `SmppTimeoutError` (`kind: 'connect'`) | Firewall, wrong host or port, IP not whitelisted by the operator | Check with `nc -vz host port` from the production machine; ask the operator to whitelist your public IP |
| `SMPP_CONNECT` with `ECONNREFUSED` | Nothing listens on that port, or TLS expected (`ssmpp://`, port 3550 by convention) | Try the other scheme |
| `SMPP_CONNECT` with `CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | The SMSC certificate is self-signed or signed by a private authority | Give the authority with `tls: { ca: readFileSync('smsc-ca.pem') }`. `rejectUnauthorized: false` exposes the credentials and is logged as a warning |
| `SMPP_CONNECT` with `ERR_SSL_WRONG_VERSION_NUMBER` | Plain TCP on a `ssmpp://` URL | Use `smpp://` |
| `ESME_RBINDFAIL`, `ESME_RINVPASWD`, `ESME_RINVSYSID` | Wrong credentials, or account not enabled for this bind mode | Operators often give separate accounts for TX and RX; check `system_type` too (some require a value) |
| `ESME_RALYBND` | The account is already bound, often by a previous instance not yet expired on the SMSC | Wait for the operator's bind timeout (usually a minute); if you need several instances, ask the operator for several binds and use `SmppPool` |
| `ESME_RINVBNDSTS` | A command the bind mode does not allow (`submit_sm` on a `receiver` bind, `deliver_sm` to a `transmitter`) | Bind as `transceiver`, or use two clients |
| `SmppTimeoutError` (`kind: 'bind'`) | The SMSC accepted the TCP connection but does not answer: wrong `interface_version`, or a proxy that waits for Proxy Protocol | Try `interface_version: 0x34` (the default) then `0x50`; check the proxy setup |

## Sending

| Status | Category | Meaning | What to do |
|---|---|---|---|
| `ESME_RTHROTTLED` | temporary | You exceed the rate the operator allows | Retried with backoff automatically (`retry`); set `rateLimit` below the contractual rate, the limiter also slows down by itself after this status |
| `ESME_RMSGQFUL` | temporary | The SMSC queue is full | Retried automatically; lower the `window` if it persists |
| `ESME_RSYSERR` | temporary | SMSC internal error | Retried automatically; contact the operator if frequent |
| `ESME_RINVDSTADR` | permanent | Destination the SMSC does not route | Check the number format (international, no `+`); some operators require TON/NPI `1/1`, others `0/1`: `destTon`, `destNpi` |
| `ESME_RINVSRCADR` | permanent | Sender not allowed | The alphanumeric sender must be registered with the operator; some require TON 5, others 0 (`sourceTon`) |
| `ESME_RINVMSGLEN` | permanent | Message too long for this SMSC | Use a different `strategy` (`udh8`, `sar` or `payload`): SMSCs differ on which they accept |
| `ESME_RINVDCS` | permanent | `data_coding` refused | Force `encoding: 'gsm7'` or `'ucs2'`; some SMSCs refuse Latin-1 (`multipart: { allowLatin1: false }`) |
| `ESME_RINVESMCLASS` | permanent | `esm_class` refused (usually the UDHI bit) | The SMSC does not take UDH: `strategy: 'sar'` or `'payload'` |
| `ESME_RSUBMITFAIL` | permanent | Generic refusal | Look at the operator's logs or portal; often a credit or routing problem |
| `ESME_RINVSERTYP` | permanent | `service_type` unknown | Leave it empty unless the operator gave you a value |
| `ESME_RINVSCHED`, `ESME_RINVEXPIRY` | permanent | Time format refused | Some SMSCs take only relative times: `validityPeriod: 24 * 3600_000` |

`client.estimate({ text })` shows the encoding and the number of segments before sending, and
which characters force UCS2 (and triple the cost of a long message).

## Timeouts and connection losses

| Symptom | Cause | What to do |
|---|---|---|
| `SmppTimeoutError` (`kind: 'request'`, `written: true`) | The SMSC accepted the PDU but never answered | The message **may** have been sent: do not resend blindly. Query it (`client.query(id)` if you have an id), or resend only idempotent traffic |
| `SmppTimeoutError` with `written: false` | The request waited in the queue for the whole `requestTimeout` | The window or the rate limit is the bottleneck: raise `window` (ask the operator), or send fewer messages |
| `SmppConnectionClosedError` with `written: false` | Connection lost before the PDU left | Safe to resend |
| `SmppConnectionClosedError` with `written: true` | Connection lost while waiting for the answer | Same as the written timeout: the SMSC may have it |
| `SmppQueueFullError` | More than `maxQueueSize` requests wait | Apply back-pressure in the application (stop reading your job queue when `client.queueSize` grows) |
| Session closes every few minutes with `enquire_link timed out` | A NAT or firewall drops idle connections, or the SMSC is overloaded | Lower `enquireLinkInterval` (15 s), check the link; the client reconnects by itself |
| `reconnectFailed` | `reconnect.maxAttempts` reached | By default attempts are unlimited; listen to `reconnecting` to alert after N attempts rather than giving up |

## Receiving

| Symptom | Cause | What to do |
|---|---|---|
| No `deliveryReport` although `registeredDelivery: true` | Bound as `transmitter`; or the operator sends receipts on a separate RX bind | Bind as `transceiver`, or open a `receiver` client |
| `deliveryReport` with `status: 'UNKNOWN'` | Receipt text in a format the parser does not know | Open an [operator variant issue](https://github.com/AristideDongo/smpp-ts/issues/new?template=operator_variant.yml) with the PDU (second argument of the event); `dlr.rawStatus` has the status text |
| Receipt `messageId` does not match the `submit_sm_resp` id | The SMSC gives a decimal id on submit and hexadecimal in receipts (or the reverse) | `messageIdFormat: 'hex-to-dec'` or `'dec-to-hex'` converts the receipt id to the submit format |
| `message` text is garbled | Wrong `data_coding` from the SMSC (0 meaning Latin-1 or UCS2 instead of GSM7) | Map `data_coding` 0 to the right encoding in an `EncodingRegistry` (`encodings` option), see the operator variants guide |
| `partialMessage` events | Segments of a long message never all arrived (`reassembly.ttl`) | The operator lost a segment; nothing to fix client-side, log it |
| `duplicate` events | The SMSC resent a receipt or message it got no answer for | Expected after a reconnection; the duplicate is dropped (`dedup` option) |
| `MaxListenersExceededWarning` | Many listeners on one client, usually one per request | Attach the listeners once at startup |

## Server

| Symptom | Cause | What to do |
|---|---|---|
| Client gets `ESME_RSYSERR` on every request | The handler threw, or took longer than `handlerTimeout` | Look at the `error` event; return a status instead of throwing for a refusal |
| `bindFailed` with `reason: 'limit'` | `maxSessions`, `maxSessionsPerIp` or `maxSessionsPerSystemId` reached | Raise them, or check for leaked sessions on the client side |
| Sessions closed after `bindTimeout` | A client connects without binding (port scanner, load balancer health check) | Expected; use a TCP health check without data, or a `bind` from the balancer |
| `rejected` with Proxy Protocol | The header came from an address outside `trustedProxies` | List the proxy's real source CIDR |

## Getting more detail

A `debug` logger prints every PDU, with passwords masked and content masked when
`redactContent: true`:

```ts
new SmppClient({ …, logger: console });
```

The `metric` event gives counters per command and status, and `client.health()` the state,
in-flight and queued requests, the last traffic and the current rate limit.
