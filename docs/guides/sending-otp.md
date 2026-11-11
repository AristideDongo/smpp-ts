---
title: Sending one-time codes (OTP)
---

# Sending one-time codes (OTP)

A verification code must arrive fast, fit in one SMS and never be sent twice by mistake.

```ts
import { SmppClient, SmppConnectionClosedError, SmppStatusError, SmppTimeoutError } from 'smpp-ts';

const client = new SmppClient({
  url: 'ssmpp://smsc.example.com:3550',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  requestTimeout: 5_000,
  trackDeliveries: { ttl: 10 * 60_000 },
});
await client.connect();

async function sendCode(phone: string, code: string, requestId: string) {
  return client.sendText({
    to: phone,
    from: 'MYAPP',
    text: `Your code is ${code}. It expires in 5 minutes.`,
    registeredDelivery: true,
    validityPeriod: 5 * 60_000, // the SMSC drops it after 5 minutes
    reference: requestId,
  });
}
```

## Keep it in one SMS

- Stay in the GSM 7-bit alphabet: one emoji or one character outside GSM7 switches the whole message to UCS2 (70 characters instead of 160).
- Check before sending: `countSegments(text)` returns the encoding and the number of segments.

```ts
import { countSegments } from 'smpp-ts';
countSegments('Your code is 123456 🎉'); // { encoding: 'ucs2', segments: 1, perSegment: 70, … }
```

## Expiry

`validityPeriod` takes a duration in ms, a `Date` or an SMPP time string. A code delivered after it has expired is useless: let the SMSC drop it.

## Never send a code twice by mistake

Every error says whether the PDU was written to the socket:

| Error | `written` | What to do |
|---|---|---|
| `SmppConnectionClosedError` | `false` | Never left: resend safely |
| `SmppConnectionClosedError` / `SmppTimeoutError` | `true` | The SMSC may have accepted it: check `deliveryReport` before resending, or ask the user to request a new code |
| `SmppStatusError` with `category: 'permanent'` | — | Invalid number, refused content: do not resend |

The library never resends on its own a message that may have been accepted. Temporary statuses (`ESME_RTHROTTLED`, `ESME_RMSGQFUL`) are retried automatically with backoff (`retry` option).

## Know when it arrived

```ts
client.on('messageStatus', (s) => {
  // s.reference === requestId; s.outcome: DELIVERED, FAILED, PARTIALLY_DELIVERED or TIMEOUT
});
```

Delivery receipts depend on the operator: some only send them for failures, some never. Agree on it before going live (see the production guide).
