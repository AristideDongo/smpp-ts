# smpp-ts

[![npm](https://img.shields.io/npm/v/smpp-ts.svg)](https://www.npmjs.com/package/smpp-ts)
[![CI](https://github.com/AristideDongo/smpp-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/AristideDongo/smpp-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Coverage](https://img.shields.io/endpoint?url=https://aristidedongo.github.io/smpp-ts/coverage-badge.json)](https://aristidedongo.github.io/smpp-ts/)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/AristideDongo/smpp-ts/badge)](https://scorecard.dev/viewer/?uri=github.com/AristideDongo/smpp-ts)
[![Zero dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)

**SMPP v3.4 / v5.0** client and server in TypeScript: secure by default, production-ready, zero runtime dependencies.

- **Secure by default**: verified TLS (TLS 1.2 minimum), passwords never logged, every field validated before sending and on receipt.
- **No message lost silently**: every request ends with a response, a typed error or a timeout. Never an endless wait.
- **The parser never crashes**: fuzz-tested on 1 million random or corrupted inputs.
- **Built in**: reconnection with re-bind, send window, rate limiting, long SMS splitting, reassembly, delivery receipts, Proxy Protocol.
- **Faithful to the spec**: PDU fields keep their SMPP names (`destination_addr`, `data_coding`…) and are typed per command.

Node ≥ 20, Bun and Deno · ESM + CJS · `.d.ts` declarations included.

```sh
npm install smpp-ts
# Deno
deno add jsr:@smpp-ts/smpp-ts
```

## Client

```ts
import { SmppClient } from 'smpp-ts';

const client = new SmppClient({
  url: 'ssmpp://smsc.example.com:3550',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  window: 10,
  rateLimit: { perSecond: 50 },
  reconnect: { initialDelay: 1_000, maxDelay: 30_000 },
  requestTimeout: 10_000,
});

await client.connect();

const result = await client.sendText({
  to: '+2250700000000',
  from: 'From',
  text: 'Your code is 123456 🎉',
  registeredDelivery: true,
});
// { messageIds: ['...'], parts: 1, encoding: 'UCS2' }

client.on('deliveryReport', (dlr) => console.log(dlr.messageId, dlr.status));
client.on('message', (msg) => console.log(`MO from ${msg.from}: ${msg.text}`));

await client.close({ drain: true });
```

### Sending

| Method | Purpose |
|---|---|
| `sendText({ to, from, text, … })` | Picks the encoding, splits the text and returns every `message_id` |
| `submit(params)` | Low-level `submit_sm` |
| `query(id)`, `cancel(id)`, `replace(id, params)` | `query_sm`, `cancel_sm`, `replace_sm` |
| `request(command, params)` | Any SMPP command |
| `raw.submit_multi(params)`, `raw.data_sm(params)`… | Typed per-command shortcuts |

`sendText` normalizes each address and derives its TON/NPI:

| Address | Sent as | TON | NPI |
|---|---|---|---|
| alphanumeric (`From`) | `From` | 5 (alphanumeric) | 0 |
| `+225 07 00 00 00 00` | `2250700000000` | 1 (international) | 1 (E.164) |
| `00225 07-00-00-00-00` | `2250700000000` | 1 (international) | 1 (E.164) |
| `07 00 00 00 00` | `0700000000` | 0 (unknown) | 1 |
| empty (sender only) | `''` | 0 | 0 |

The `sourceTon`, `sourceNpi`, `destTon` and `destNpi` options override these values.

An address no network would accept is rejected **before sending** with a `SmppValidationError`: non-numeric destination, international number longer than 15 digits, alphanumeric sender longer than 11 characters or with characters outside the GSM 7-bit alphabet. Beyond 11 characters, networks truncate or reject the sender, often without any visible error. For an operator with different rules:

```ts
new SmppClient({
  …,
  address: {
    internationalPrefix: '011',   // default '00'; false to disable
    maxAlphanumericLength: 15,    // default 11
    validateSender: false,        // stop validating the alphanumeric sender
    normalize: false,             // send addresses exactly as given
  },
});
```

### SMS cost: GSM7 normalization

One curly apostrophe (`’`, common in text pasted from a word processor or typed on a phone) is enough to send a whole message in UCS2: 70 characters per SMS instead of 160, so two or three times the segments billed. `normalize` replaces such characters with their GSM7 equivalent, **only when it saves segments** (a text that stays in UCS2 anyway, because of an emoji, is sent unchanged):

| Mode | Replaces | Example |
|---|---|---|
| `punctuation` | Curly quotes, `«»`, dashes, `…`, special spaces, invisible characters | `aujourd’hui` → `aujourd'hui` |
| `transliterate` | The above, plus letters missing from GSM7 (accent dropped) | `Côte`, `garçon`, `cœur` → `Cote`, `garcon`, `coeur` |

Characters GSM7 already has (`é è à ù ì ò Ç Ñ Ü ß €`…) are never touched.

```ts
const client = new SmppClient({ …, normalize: 'punctuation' });   // default: false
await client.sendText({ to, from, text, normalize: 'transliterate' }); // per message
// → { messageIds, parts: 1, encoding: 'GSM7', replacements: 2 }
```

`estimate()` shows what a text costs before sending it, and what normalization would save:

```ts
client.estimate({ text: 'Votre colis arrive aujourd’hui, à bientôt sur notre boutique ! …' });
// {
//   encoding: 'ucs2', segments: 2, perSegment: 67, remaining: 41,
//   nonGsm7: ['’', 'ô'],                                   // what forces UCS2
//   suggestion: { normalize: 'transliterate', segments: 1, encoding: 'gsm7' },
//   …
// }
```

`estimateText`, `normalizeForGsm7` and `nonGsm7Characters` are exported for use without a client (a campaign editor showing the cost as the user types).

### Priorities

`priority` (0 to 3) sets `priority_flag` **and** the place in the local send queue: a higher priority leaves the queue first, so an OTP does not wait behind 10,000 queued marketing messages. Within a priority, order is FIFO. `submit()` uses its `priority_flag`, any request accepts `{ priority }`.

```ts
await client.sendText({ to, from, text: 'Your code: 123456', priority: 3 });
```

A starvation guard keeps lower priorities moving: after `queueFairness` (default 10) requests in a row from a higher priority while a lower one waits, the longest-waiting lower request goes out. `queueFairness: 0` gives strict priority.

### Delivery tracking

A long SMS is sent as several segments, and each segment gets its own receipt. With `trackDeliveries`, the library groups them and emits a single outcome per message:

```ts
const client = new SmppClient({ …, trackDeliveries: true });

client.on('messageStatus', (s) => {
  // s.outcome: 'DELIVERED' | 'FAILED' | 'PARTIALLY_DELIVERED' | 'TIMEOUT'
  db.updateSms(s.reference, s.outcome, s.reports);
});

await client.sendText({ to, from, text, registeredDelivery: true, reference: 'sms-8812' });
```

- Only sends with `registeredDelivery: true` (final receipt requested) are tracked.
- `TIMEOUT`: not every final receipt arrived within `ttl` (24 h by default).
- Bounded memory: `trackDeliveries: { ttl, maxTracked }` (100,000 messages by default). A receipt that arrives before its `submit_sm_resp` is kept for 60 s.
- Tracking is in memory by default. To survive a restart, give it a store (Redis, SQL, a file…): every change is written through, and the next client reloads it before its first bind.
- `DeliveryTracker` is exported for standalone use, for example across several clients.

```ts
const store: DeliveryTrackerStore = {
  save: (record) => redis.hset('smpp:tracking', record.key, JSON.stringify(record)),
  delete: (key) => redis.hdel('smpp:tracking', key),
  load: async () => Object.values(await redis.hgetall('smpp:tracking')).map((v) => JSON.parse(v)),
};
new SmppClient({ …, trackDeliveries: { store } });
```

Records are plain data (`JSON.stringify` works, dates are revived on reload). If the store fails, tracking goes on in memory and the error is logged. The library ships no storage: the store belongs to the application.

#### Duplicates

When a `deliver_sm_resp` gets lost (connection dropped just before the SMSC read it), the SMSC sends the receipt or the message again after the reconnection. `dedup` drops these copies before they reach `deliveryReport`, `messageStatus` or `message`, and emits `duplicate` instead (the copy is still acknowledged, so the SMSC stops resending it):

| Option | Default | Drops |
|---|---|---|
| `receipts` | `true` | A receipt with the same `message_id` and status as one already received (within `ttl`, 1 h) |
| `messages` | `false` | An incoming message or segment with the same sender, recipient and content (within `messageTtl`, 2 min). Off by default: a user may really send "OK" twice |

```ts
new SmppClient({ …, dedup: { messages: true } });          // dedup: false disables both
client.on('duplicate', (kind, pdu) => metrics.increment(`sms.duplicate.${kind}`));
```

Memory is bounded (`maxEntries`, 100,000 keys). To drop copies that arrive on another process, give it a `store` with a synchronous `seen(key, ttlMs)` check-and-set (a local cache in front of Redis, for instance). An `SmppPool` deduplicates across its binds.

Two other sources can be plugged in the same way:

| Option | Default | Use |
|---|---|---|
| `sequenceGenerator: { next() }` | Counter per session, from 1 | Keep `sequence_number` values going across restarts. Called synchronously; values in flight are skipped |
| `concatReference: () => number` | Counter from a random value | Share long-message references between processes that send to the same numbers (`SmppPool` already shares them between its binds) |

### Errors

Every error extends `SmppError` and carries a stable `code`:

| Class | When |
|---|---|
| `SmppStatusError` | Response with `command_status ≠ 0`: `status`, `statusName`, `category` (`temporary`, `permanent`, `session`) |
| `SmppTimeoutError` | Timeout (request, bind, keepalive…): `kind`, `written` |
| `SmppConnectionClosedError` | Connection closed with a pending request: `written` |
| `SmppQueueFullError` | Send queue full |
| `SmppAbortError` | Request cancelled through its `AbortSignal`: `written` |
| `SmppStateError` | Operation not allowed in the current state or bind mode |
| `SmppValidationError` | Invalid parameter: no PDU was sent |
| `SmppDecodeError` | Invalid PDU received |
| `SmppMultipartError` | Partial failure of a multi-segment send: `results` |

`written` tells whether the PDU was written to the socket. With `written: false`, the message never left and can be resent safely. With `written: true`, the SMSC may have accepted it, and resending may create a duplicate. The library never resends on its own a message that may have been accepted: the application decides.

An `error` event without a listener does not end the process: it goes to the logger.

### Reliability

| Option | Default | Effect |
|---|---|---|
| `connectTimeout` | 10 s | Rejects `connect()` |
| `bindTimeout` | 10 s | Rejects the bind |
| `requestTimeout` | 10 s | Rejects the request (queue time included) |
| `enquireLinkInterval` | 30 s | Sends an `enquire_link` after this long without traffic |
| `enquireLinkTimeout` | 10 s | No answer: the session is declared dead, then reconnects |
| `unbindTimeout` | 5 s | Forces the socket closed |
| `window` | 10 | Concurrent in-flight requests |
| `maxQueueSize` | 10,000 | Beyond this: `SmppQueueFullError` |
| `reconnect` | on | Exponential backoff with jitter, unlimited attempts |
| `retry` | 2 retries | Only on temporary statuses (`ESME_RTHROTTLED`, `ESME_RMSGQFUL`, `ESME_RSYSERR`) |
| `rateLimit` | none | Token bucket; the rate drops automatically on `ESME_RTHROTTLED` / `ESME_RMSGQFUL` |
| `maxWriteBuffer` | 1 MiB | Bytes waiting in the socket write buffer before the session is closed |

While the socket write buffer is full, the session stops reading until the peer catches up (backpressure in both directions).

Every request accepts an `AbortSignal`, and so do `sendText` and `connect`:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 2_000);
await client.connect({ signal: AbortSignal.timeout(5_000) });
await client.sendText({ to, from, text, signal: ac.signal });
await client.submit(params, { signal: ac.signal });
```

The request is rejected with `SmppAbortError`. `written: false` means it never left; `written: true` means it was already written and the SMSC may still accept it. With `sendText`, only the segments not sent yet are cancelled.

During a reconnection, messages not yet written stay queued and go out after the re-bind. Messages in flight when the connection dropped are rejected with `SmppConnectionClosedError` (`written: true`).

`close({ drain: true })` refuses new sends, waits for pending requests to finish, sends `unbind`, then closes the connection.

**SMPP 5.0 congestion.** An SMSC can report its load in the `congestion_state` TLV of its responses (0 to 100). With `rateLimit`, the client slows down from `congestionThreshold` (default 90, "nearing congestion"), as it does on `ESME_RTHROTTLED`, instead of waiting to be throttled. The last value is in `health()` and in the `session.congestion` metric.

**Health.** `health()` returns a snapshot for a readiness probe or a dashboard:

```ts
app.get('/ready', (_req, res) => {
  const h = client.health();
  // { healthy, state, reconnecting, reconnectAttempt, inflight, queued, queuedByPriority,
  //   lastReceivedAt, boundAt, congestionState, rateLimit, trackedMessages }
  res.status(h.healthy ? 200 : 503).json(h);
});
```

**Credential rotation.** `updateBind({ password })` changes the bind parameters for the next bind; `rebind()` applies them now, without losing anything: queued requests stay queued, in-flight requests get their response first, then the session unbinds and binds again. If the new bind fails, `rebind()` rejects and the usual reconnection takes over.

```ts
client.updateBind({ password: await vault.read('smpp/password') });
await client.rebind();
```

### TLS

Certificate verification is **on by default**. If the SMSC uses a self-signed certificate, provide its certificate authority instead of disabling verification:

```ts
new SmppClient({
  url: 'ssmpp://smsc.example.com:3550',
  tls: { ca: readFileSync('smsc-ca.pem') },
  bind: { … },
});
```

`rejectUnauthorized: false` is still possible, but every connection then logs a warning.

### Long messages

| `multipart.strategy` | Mechanism |
|---|---|
| `udh8` (default) | 8-bit concatenation UDH (IEI 0x00) |
| `udh16` | 16-bit concatenation UDH (IEI 0x08) |
| `sar` | `sar_msg_ref_num`, `sar_total_segments`, `sar_segment_seqnum` TLVs |
| `payload` | A single PDU with `message_payload` |

Splitting never breaks a GSM escape sequence or an emoji (UTF-16 surrogate pair). On receipt, segments are reassembled by (source, destination, reference), with a lifetime (`reassembly.ttl`, 5 min) and a maximum number of incomplete messages in memory (`reassembly.maxBuffers`, 1,000). On expiry, the `partialMessage` event delivers whatever was received.

Each segment is billed as one SMS. `multipart.maxSegments` (or `maxSegments` per call) caps the number of segments: a longer text is rejected with a `SmppValidationError` (`ESME_RINVMSGLEN`) before anything is sent. Default: 255, the protocol maximum.

`flash: true` sends a flash SMS (message class 0: shown at once, not stored by the handset). It works with GSM7, UCS2 and binary content; with Latin-1 or ASCII it is rejected before sending.

### Several binds (`SmppPool`)

Operators often cap the throughput of each bind (for example 50 msg/s) and allow several binds per account. `SmppPool` opens them all behind the same API as `SmppClient`:

```ts
import { SmppPool } from 'smpp-ts';

const pool = new SmppPool({
  url: 'ssmpp://smsc.example.com:3550',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  size: 4,                       // 4 identical binds
  rateLimit: { perSecond: 50 },  // per bind: 200 msg/s in total
  trackDeliveries: true,
});

await pool.connect();            // resolves as soon as `minBound` binds are up (default 1)
await pool.sendText({ to, from, text, registeredDelivery: true });
pool.on('messageStatus', (s) => console.log(s.outcome));
```

| Option | Default | Effect |
|---|---|---|
| `size` | 2 | Number of identical binds |
| `members` | none | One entry per bind, merged over the shared options: another host for failover, another `system_id`… (`bind` is merged field by field). Replaces `size` |
| `strategy` | `least-busy` | `least-busy`: the bind with the fewest requests in flight or queued. `round-robin`: each bind in turn |
| `minBound` | 1 | Binds that must be up for `connect()` to resolve |

- Every other option (window, timeouts, `rateLimit`, `retry`…) applies to **each** bind.
- When a bind goes down, sends go through the others while it reconnects. A bind that fails its first connection is retried in the background with the `reconnect` backoff. Events: `memberUp`, `memberDown`.
- A send that was not written (bind closed, queue full) moves to another bind. A send that was written is never resent: same rule as `SmppClient` (`written`).
- All the segments of a `sendText` go through the same bind, and concatenation references are shared by the pool: two binds never use the same reference at the same time.
- Receipts and incoming messages are processed once for the whole pool. A receipt can arrive on another bind than its `submit_sm`, and the segments of a long incoming message can arrive on different binds: `messageStatus` and `message` still work.
- `pool.members` gives access to each `SmppClient` (state, `raw` API).

## Testing your application

`smpp-ts/testing` starts an SMSC in the test process: it records what the application sends, answers it, sends receipts and incoming messages, and reproduces the failures that are hard to get from a real SMSC.

```ts
import { COMMAND_STATUS, SmppClient } from 'smpp-ts';
import { createTestSmsc } from 'smpp-ts/testing';

const smsc = await createTestSmsc({ receipts: 'DELIVERED', receiptDelay: 50 });
const client = new SmppClient({ url: smsc.url, bind: { mode: 'transceiver', system_id: 'test', password: 'x' } });
await client.connect();

await sendOtp(client, '2250700000000');            // your code
expect(smsc.submitted[0]?.text).toMatch(/\d{6}/);

smsc.throttleNext(2);                              // ESME_RTHROTTLED twice
smsc.failNext('submit_sm', COMMAND_STATUS.ESME_RINVDSTADR);
smsc.dropNext('submit_sm');                        // never answered: request timeout
smsc.disconnectOnNext('submit_sm');                // connection cut with the request in flight
smsc.setCongestion(95);                            // congestion_state in every response
await smsc.sendMo({ from: '2250700000000', to: '1234', text: 'STOP' });
await smsc.sendReceipt({ messageId: '1', status: 'UNDELIVERABLE', from: '2250700000000', to: 'ACME' });
await smsc.waitFor('submit_sm', { count: 3 });

await smsc.close();
```

Options: accepted `systemId` / `password` (or `authenticate`), `receipts` (a status, `none`, or a function of the PDU), `receiptDelay`, `duplicateReceipts`, `messageId`. `received`, `submitted` and `binds` record the traffic (never the password); `reset()` clears them between tests. It works with Vitest, Jest and `node:test`, and needs no Docker.

## Server

```ts
import { SmppServer, safeCompare, COMMAND_STATUS } from 'smpp-ts';

const server = new SmppServer({
  authenticate: async ({ system_id, password, remoteAddress, mode }) => {
    const account = await db.findAccount(system_id);
    return account && safeCompare(password, account.password) ? { accountId: account.id } : false;
  },
  handlers: {
    submit_sm: async (pdu, session) => {
      const id = await queue.push(pdu);
      return { message_id: id };          // or a status: return COMMAND_STATUS.ESME_RINVDSTADR
    },
  },
  tls: { key, cert },                     // optional
});

await server.listen(2775);
await server.deliver('system_id', { source_addr: '…', destination_addr: '…', short_message: Buffer.from('…') });
```

- `authenticate` is required. A refusal always returns `ESME_RBINDFAIL`, whether the account exists or not, so accounts cannot be enumerated.
- Until a session is bound, it only handles `bind_*`, `enquire_link`, `unbind` and `generic_nack`. Any other command gets `ESME_RINVBNDSTS`.
- A `transmitter` session does not receive `deliver_sm`, and a `receiver` session cannot send `submit_sm`.
- If a handler fails or does not answer within `handlerTimeout` (10 s), the server answers `ESME_RSYSERR`.
- Built-in limits: `bindTimeout` (30 s), `handshakeTimeout` (TLS, 10 s), `idleTimeout` (5 min), `maxSessions` (1,000), `maxSessionsPerIp` (50), `maxSessionsPerSystemId` (10), and a temporary IP ban after repeated failed binds (`bindFailures`).
- `maxSessions` and `maxSessionsPerIp` count every connection from the moment it is accepted, including those still sending their PROXY header or doing their TLS handshake. `maxSessionsPerSystemId` counts binds still being authenticated, so concurrent binds cannot exceed it.
- `bindFailures` bans by IP. Brute force on one `system_id` from many addresses must be handled in `authenticate()` (with a shared store when several instances run).
- Inbound window: at most `inboundWindow` (10) requests per session wait for their handler at the same time. Beyond that, reading pauses until a handler answers (`inboundWindowPolicy: 'pause'`, default), or extra requests get `ESME_RTHROTTLED` at once (`'throttle'`).
- A peer that never reads its responses cannot grow memory: reading pauses while the write buffer is full, and the session is closed beyond `maxWriteBuffer` (1 MiB).
- Proxy Protocol v1 and v2, off by default: `proxyProtocol: { trustedProxies: ['10.0.0.0/8'] }`. A PROXY header from an unlisted address is rejected.

## Utilities

```ts
import { countSegments, detectEncoding, parseDlr, formatRelativeTime, parseSmppTime } from 'smpp-ts';

countSegments('Hello {world} €');
// { encoding: 'gsm7', segments: 1, units: 18, perSegment: 160, remaining: 142, … }

detectEncoding('Şişli', { shiftTables: ['tr'] });   // { encoding: 'gsm7', shift: 'tr' }
detectEncoding('नमस्ते', { shiftTables: ['hi'] });  // { encoding: 'gsm7', shift: 'hi', locking: 'hi' }
parseDlr('id:123 sub:001 dlvrd:001 … stat:DELIVRD err:000 text:…');
formatRelativeTime(2 * 3600_000);                    // '000000020000000R'
```

| Encoding | `data_coding` | Single | With 8-bit UDH |
|---|---|---|---|
| GSM7 | 0x00 | 160 characters | 153 characters |
| Latin-1 | 0x03 | 140 characters | 134 characters |
| UCS2 | 0x08 | 70 units | 67 units |

Characters from the GSM extension table (`€ [ ] { } \ ^ ~ |`) count as 2. Automatic detection only uses Latin-1 and the national language tables if you allow them, because many operators and handsets do not support them. With a forced encoding, unrepresentable text throws instead of being silently replaced with `?`. The `encodings` registry accepts operator-specific encodings.

#### National language tables (3GPP TS 23.038)

All 13 languages of the standard: Turkish (`tr`), Spanish (`es`), Portuguese (`pt`), Bengali and Assamese (`bn`), Gujarati (`gu`), Hindi (`hi`), Kannada (`kn`), Malayalam (`ml`), Oriya (`or`), Punjabi (`pa`), Tamil (`ta`), Telugu (`te`) and Urdu (`ur`).

- The **single shift** table (UDH IE 0x24, 3 octets) replaces the extension table: its characters cost 2 septets.
- The **locking shift** table (UDH IE 0x25, 3 octets) replaces the default alphabet: its characters cost 1 septet. Every language but Spanish has one.

```ts
const client = new SmppClient({ …, multipart: { shiftTables: ['hi'] } });
await client.sendText({ to, from, text: 'नमस्ते, आपका कोड 123456 है।' });
// GSM7 + Hindi locking and single shift tables: 152 characters per SMS instead of 70 in UCS2
```

For each allowed language, detection tries the single shift table alone first, then both tables. `shift` and `locking` force them in `sendText` / `countSegments`. Incoming messages that announce these tables are decoded automatically.

Check with the operator first: a handset that does not know a table displays the wrong characters.

## Logs and metrics

```ts
new SmppClient({ …, logger: console });        // or pinoAdapter(pino())
new SmppClient({ …, redactContent: true, redactNumbers: true });
client.on('metric', (m) => prometheus.observe(m));
```

- The logger is silent by default. Passwords are always masked; SMS content and numbers are masked on request.
- Every log line carries `sessionId`, `systemId`, `remoteAddress`, `command` and `sequence_number`.
- Emitted metrics: `pdu.sent`, `pdu.received`, `request.latency`, `request.timeout`, `request.inflight`, `queue.size`, `session.reconnect`, `session.congestion`, `inbound.duplicate`, `command_status`, `bytes.in` and `bytes.out`.

### OpenTelemetry

```ts
import { metrics } from '@opentelemetry/api';
import { instrumentSmpp } from 'smpp-ts/otel';

const detach = instrumentSmpp(client, metrics.getMeter('sms-gateway'), {
  attributes: { 'smpp.operator': 'orange-ci' },
});
instrumentSmpp(server, metrics.getMeter('smsc')); // adds smpp.system_id to every measurement
```

`smpp-ts/otel` does not import `@opentelemetry/api`: it receives your application's `Meter`, so the package stays dependency-free. Instruments are named `smpp.<metric>` (`smpp.request.latency` in ms, `smpp.bytes.out` in bytes…).

## Low level

```ts
import { encodePdu, decodePdu, PduCodec, Framer } from 'smpp-ts';

const buf = encodePdu({ command: 'submit_sm', destination_addr: '225…', short_message: Buffer.from('Hi') });
const pdu = decodePdu(buf);
if (pdu.command === 'submit_sm') pdu.short_message; // typed

// Operator-specific TLVs
const codec = new PduCodec({ customTlvs: [{ name: 'operator_ref', tag: 0x1501, type: 'cstring', max: 32 }] });
```

## Documentation

API reference and guides: **https://aristidedongo.github.io/smpp-ts/**

- [Sending one-time codes (OTP)](docs/guides/sending-otp.md)
- [Bulk campaigns](docs/guides/bulk-campaigns.md)
- [Receiving messages (MO)](docs/guides/receiving-messages.md)
- [Delivery receipts](docs/guides/delivery-reports.md)
- [Building an SMPP server](docs/guides/building-a-server.md)
- [Going to production](docs/PRODUCTION.md)
- [Testing an application that sends SMS](docs/guides/testing.md)
- [Migration plan](docs/guides/migration-plan.md)
- [Design decisions](docs/decisions.md)
- [Comparison with other SMPP libraries](docs/guides/comparison.md)
## Interoperability

Every pull request tests the library against eight implementations it did not write:

| smpp-ts as | Peer |
|---|---|
| Client | **Jasmin** (Python SMS gateway), **smscsim** (Go), **jsmpp** (Java), **Cloudhopper** (Java, Netty) |
| Server | **Kannel** (C SMS gateway, `bearerbox` + `smsbox`), **python-smpplib** (Python), **gosmpp** (Go), **php8-smpp** (PHP, fork of onlinecity/php-smpp) |

Matrix, versions and instructions: [test/interop/README.md](test/interop/README.md).
## Command line

The package ships a command with two tools, handy when you have no access to an operator's test SMSC yet.

**SMSC simulator**: accepts binds, answers every `submit_sm`, sends receipts.

```sh
npx smpp-ts smsc --port 2775 --system-id demo --password secret --dlr random --echo
```

| Option | Default | Effect |
|---|---|---|
| `--port`, `--host` | 2775, 127.0.0.1 | Where to listen (local only by default) |
| `--system-id`, `--password` | any | Credentials to accept |
| `--dlr` | `delivered` | Receipts: `delivered`, `undeliverable`, `random` (80% delivered), `none` |
| `--dlr-delay` | 1000 ms | Delay before each receipt |
| `--echo` | off | Answers each SMS with an MO `echo: <text>` |
| `--tls-key`, `--tls-cert` | none | Serves `ssmpp://` |

**Send an SMS**, and optionally wait for its receipt (exit code 0 if delivered):

```sh
npx smpp-ts send --url smpp://127.0.0.1:2775 --system-id demo --password secret \
  --from MYAPP --to +2250700000000 --text "Your code is 123456" --dlr
```

For an SMSC with a self-signed certificate, `--ca smsc-ca.pem`: verification stays on.

## Going to production

Before connecting to an operator, read the [production guide](docs/PRODUCTION.md): what to ask them, the settings that follow from it and the tests to run against their test SMSC.

## Performance

Measured with `npm run bench` (Node 24.21, Intel Core i5-8250U laptop from 2017, Linux, idle machine). Median of 5 runs.

**Client against an SMSC in another process.** `bench/sink.mjs` is a minimal SMSC written with `node:net` only (no SMPP library), started in its own process: the client has a CPU core to itself, as against a real SMSC. This is the figure to compare with other libraries' "against a sink" numbers.

| `submit_sm` throughput | Result |
|---|---|
| window 10 | 61,700 msg/s |
| window 50 | 88,000 msg/s |
| window 100 | 90,900 msg/s |

**Client and server of the library in the same process.** One CPU core does both sides: a lower bound.

| Benchmark | Result |
|---|---|
| `submit_sm`, window 1 | 7,300 msg/s |
| `submit_sm`, window 10 | 21,300 msg/s |
| `submit_sm`, window 50 | 26,900 msg/s |
| Round trip, window 1 | p50 0.12 ms · p99 0.18 ms |

**Codec and utilities.**

| Benchmark | Result |
|---|---|
| Encode `submit_sm` | 290,000 ops/s |
| Decode `submit_sm` | 226,000 ops/s |
| GSM7 encoding (160 characters) | 173,000 ops/s |
| Split a UCS2 text into 6 parts | 28,000 ops/s |
| Parse a DLR text | 118,000 ops/s |

The writes of one batch of responses leave in a single system call (`cork` / `uncork`), the send queue is O(1), and TLVs are encoded from the parameters actually given.

In practice, the operator's throughput limit (often 10 to 500 msg/s per bind) is reached long before the library's.

Every pull request runs the benchmarks on the base branch and on the PR on the same CI runner, and fails if a throughput drops by more than 25%. Run them yourself:

```sh
npm run bench                                   # table
node bench/run.mjs --json results.json          # JSON, after npm run build
node bench/compare.mjs base.json head.json      # comparison, exit code 1 on regression
```

## Development

```sh
npm test               # unit, property, fuzzing (20,000 iterations), integration
npm run fuzz           # parser fuzzing, 1,000,000 iterations
npm run coverage
npm run test:runtime   # smoke test on the built package (also: bun / deno run -A test/runtime/smoke.mjs)
npm run test:interop   # against third-party SMSCs and clients, see test/interop/README.md
npm run bench          # benchmarks (see Performance)
npm run docs           # API reference and guides in docs-site/
npm run typecheck && npm run lint && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [MIGRATION.md](MIGRATION.md).

## License

MIT
