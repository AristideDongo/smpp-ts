---
title: Bulk campaigns
---

# Bulk campaigns

Sending thousands of messages means respecting the operator's throughput, keeping memory bounded and knowing, at the end, what was delivered.

```ts
import { SmppPool } from 'smpp-ts';

const pool = new SmppPool({
  url: 'ssmpp://smsc.example.com:3550',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  size: 4,                        // binds allowed by the operator
  rateLimit: { perSecond: 50 },   // per bind: 200 msg/s in total
  window: 20,                     // requests in flight per bind
  trackDeliveries: true,
  multipart: { maxSegments: 3 },  // never bill more than 3 SMS per recipient
});
await pool.connect();
```

## Throughput

- **`rateLimit`** caps each bind (token bucket). On `ESME_RTHROTTLED` or `ESME_RMSGQFUL`, the rate drops automatically, then recovers.
- **`window`** caps the requests in flight per bind. Beyond, requests wait in a bounded queue (`maxQueueSize`, 10,000).
- **`SmppPool`** spreads the load over several binds (`least-busy` by default) and keeps sending through the others when one goes down.

## Feed it without blowing up memory

Do not call `sendText` for 100,000 recipients at once: the queue would refuse them (`SmppQueueFullError`). Keep a bounded number in progress:

```ts
async function sendAll(recipients: string[], text: string, concurrency = 200) {
  const results: Array<{ to: string; ok: boolean; error?: string }> = [];
  let next = 0;
  async function worker() {
    while (next < recipients.length) {
      const to = recipients[next++]!;
      try {
        await pool.sendText({ to, from: 'BRAND', text, registeredDelivery: true, reference: to });
        results.push({ to, ok: true });
      } catch (err) {
        results.push({ to, ok: false, error: (err as Error).message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
```

## Long messages and cost

Each segment is billed. `pool.estimate({ text })` tells you how many before sending, which characters push the text to UCS2, and what GSM7 normalization would save (`suggestion`). `multipart.maxSegments` rejects a text that would need more, before anything is sent.

On a campaign, one curly apostrophe or one `ô` can double the bill: with `normalize: 'punctuation'` (or `'transliterate'`, which also drops accents GSM7 does not have), the text is sent in GSM7 whenever that saves segments.

```ts
const e = pool.estimate({ text });
if (e.suggestion) console.warn(`normalize: '${e.suggestion.normalize}' → ${e.suggestion.segments} SMS instead of ${e.segments}`);
```

## Urgent messages during a campaign

Messages sent with `priority: 3` (OTP, alerts) leave the send queue before queued campaign messages; a starvation guard (`queueFairness`, 10 by default) keeps the campaign moving.

## Outcome

`messageStatus` gives one outcome per message (`reference` = what you passed), whatever the number of segments and whatever bind the receipts arrive on. Messages without a final receipt after `ttl` (24 h by default) end as `TIMEOUT`.

## Stop cleanly

```ts
await pool.close({ drain: true }); // waits for requests in flight, then unbinds
```
