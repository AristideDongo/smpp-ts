# smpp-ts

[![npm](https://img.shields.io/npm/v/smpp-ts.svg)](https://www.npmjs.com/package/smpp-ts)
[![CI](https://github.com/AristideDongo/smpp-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/AristideDongo/smpp-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**SMPP v3.4 / v5.0** client and server in TypeScript: secure by default, production-ready, zero runtime dependencies.

- **Secure by default**: verified TLS (TLS 1.2 minimum), passwords never logged, every field validated before sending and on receipt.
- **No message lost silently**: every request ends with a response, a typed error or a timeout. Never an endless wait.
- **The parser never crashes**: fuzz-tested on 1 million random or corrupted inputs.
- **Built in**: reconnection with re-bind, send window, rate limiting, long SMS splitting, reassembly, delivery receipts, Proxy Protocol.
- **Faithful to the spec**: PDU fields keep their SMPP names (`destination_addr`, `data_coding`…) and are typed per command.

Node ≥ 20, Bun and Deno · ESM + CJS · `.d.ts` declarations included.

```sh
npm install smpp-ts
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
- Tracking is in memory. After a restart, match receipts (`deliveryReport`) against your own records by `messageId`.
- `DeliveryTracker` is exported for standalone use, for example across several clients.

### Errors

Every error extends `SmppError` and carries a stable `code`:

| Class | When |
|---|---|
| `SmppStatusError` | Response with `command_status ≠ 0`: `status`, `statusName`, `category` (`temporary`, `permanent`, `session`) |
| `SmppTimeoutError` | Timeout (request, bind, keepalive…): `kind`, `written` |
| `SmppConnectionClosedError` | Connection closed with a pending request: `written` |
| `SmppQueueFullError` | Send queue full |
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

During a reconnection, messages not yet written stay queued and go out after the re-bind. Messages in flight when the connection dropped are rejected with `SmppConnectionClosedError` (`written: true`).

`close({ drain: true })` refuses new sends, waits for pending requests to finish, sends `unbind`, then closes the connection.

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
- Built-in limits: `bindTimeout` (30 s), `idleTimeout` (5 min), `maxSessions`, `maxSessionsPerIp`, `maxSessionsPerSystemId`, and a temporary IP ban after repeated failed binds (`bindFailures`).
- Proxy Protocol v1 and v2, off by default: `proxyProtocol: { trustedProxies: ['10.0.0.0/8'] }`. A PROXY header from an unlisted address is rejected.

## Utilities

```ts
import { countSegments, detectEncoding, parseDlr, formatRelativeTime, parseSmppTime } from 'smpp-ts';

countSegments('Hello {world} €');
// { encoding: 'gsm7', segments: 1, units: 18, perSegment: 160, remaining: 142, … }

detectEncoding('Şişli', { shiftTables: ['tr'] });   // { encoding: 'gsm7', shift: 'tr' }
parseDlr('id:123 sub:001 dlvrd:001 … stat:DELIVRD err:000 text:…');
formatRelativeTime(2 * 3600_000);                    // '000000020000000R'
```

| Encoding | `data_coding` | Single | With 8-bit UDH |
|---|---|---|---|
| GSM7 | 0x00 | 160 characters | 153 characters |
| Latin-1 | 0x03 | 140 characters | 134 characters |
| UCS2 | 0x08 | 70 units | 67 units |

Characters from the GSM extension table (`€ [ ] { } \ ^ ~ |`) count as 2. Automatic detection only uses Latin-1 and the national shift tables (Turkish, Spanish, Portuguese) if you allow them, because many operators do not support them. With a forced encoding, unrepresentable text throws instead of being silently replaced with `?`. The `encodings` registry accepts operator-specific encodings.

## Logs and metrics

```ts
new SmppClient({ …, logger: console });        // or pinoAdapter(pino())
new SmppClient({ …, redactContent: true, redactNumbers: true });
client.on('metric', (m) => prometheus.observe(m));
```

- The logger is silent by default. Passwords are always masked; SMS content and numbers are masked on request.
- Every log line carries `sessionId`, `systemId`, `remoteAddress`, `command` and `sequence_number`.
- Emitted metrics: `pdu.sent`, `pdu.received`, `request.latency`, `request.timeout`, `request.inflight`, `queue.size`, `session.reconnect`, `command_status`, `bytes.in` and `bytes.out`.

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

## Going to production

Before connecting to an operator, read the [production guide](docs/PRODUCTION.md): what to ask them, the settings that follow from it and the tests to run against their test SMSC.

## Development

```sh
npm test               # unit, property, fuzzing (20,000 iterations), integration
npm run fuzz           # parser fuzzing, 1,000,000 iterations
npm run coverage
npm run test:runtime   # smoke test on the built package (also: bun / deno run -A test/runtime/smoke.mjs)
npm run test:interop   # against a third-party SMSC, see test/interop/README.md
npm run typecheck && npm run lint && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [MIGRATION.md](MIGRATION.md).

## License

MIT
