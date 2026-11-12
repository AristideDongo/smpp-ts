---
title: Testing an application that sends SMS
---

# Testing an application that sends SMS

`smpp-ts/testing` starts an SMSC inside the test process. Your code connects to it like to a real one; the test reads what was sent, plays receipts and incoming messages, and injects failures. No Docker, no network, no operator account.

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SmppClient } from 'smpp-ts';
import { type TestSmsc, createTestSmsc } from 'smpp-ts/testing';

let smsc: TestSmsc;
let client: SmppClient;

beforeEach(async () => {
  smsc = await createTestSmsc();
  client = new SmppClient({
    url: smsc.url,
    bind: { mode: 'transceiver', system_id: 'test', password: 'x' },
    reconnect: { initialDelay: 10 },
    retry: { initialDelay: 10 },
  });
  await client.connect();
});

afterEach(async () => {
  await client.close();
  await smsc.close();
});

it('sends the code', async () => {
  await sendOtp(client, '2250700000000'); // your code
  expect(smsc.submitted).toHaveLength(1);
  expect(smsc.submitted[0]).toMatchObject({ to: '2250700000000', from: 'MYAPP' });
  expect(smsc.submitted[0]?.text).toMatch(/\d{6}/);
});
```

## What is recorded

| Property | Content |
|---|---|
| `submitted` | Every `submit_sm` / `data_sm`: `from`, `to`, decoded `text` (per segment), `messageId`, raw `pdu`, `systemId` |
| `received` | Every request received, binds excluded |
| `binds` | Successful binds: `systemId`, `mode` (the password is never recorded) |
| `errors` | Receipts that could not be sent |

`waitFor('submit_sm', { count: 3, timeout: 2000 })` waits until that many requests arrived (or a predicate matches). `reset()` clears the records and the pending faults.

## Receipts and incoming messages

By default, every `submit_sm` that asks for a receipt gets a `DELIVERED` one at once. Options: `receipts` (a status, `'none'`, or `(pdu) => status`), `receiptDelay`, `duplicateReceipts` (each receipt sent twice, to test duplicate handling), `messageId: (n) => string`.

```ts
const smsc = await createTestSmsc({
  receipts: (pdu) => (pdu.destination_addr.startsWith('225') ? 'DELIVERED' : 'UNDELIVERABLE'),
  receiptDelay: 100,
});

await smsc.sendMo({ from: '2250700000000', to: '1234', text: 'STOP' }); // long texts are split
await smsc.sendReceipt({ messageId: '42', status: 'EXPIRED', from: '2250700000000', to: 'MYAPP' });
```

## Failures

| Call | Simulates | What the client sees |
|---|---|---|
| `throttleNext(n)` | SMSC over its rate | `ESME_RTHROTTLED`, retried automatically (`retry`) |
| `failNext(command, status, n)` | Any error status | `SmppStatusError` (or a retry for a temporary status) |
| `dropNext(command, n)` | Response lost | `SmppTimeoutError` with `written: true` |
| `delayNext(command, ms, n)` | Slow SMSC | Requests pile up in the queue (priorities, window) |
| `disconnectOnNext(command)` | Connection cut with the request in flight | `SmppConnectionClosedError` with `written: true`, then reconnection |
| `disconnectAll()` | Network failure | Reconnection, queued messages go out after the re-bind |
| `setCongestion(level)` | SMPP 5.0 `congestion_state` in every response | The rate limiter slows down from `congestionThreshold` |

```ts
it('does not send the code twice when the response is lost', async () => {
  smsc.dropNext('submit_sm');
  await expect(sendOtp(client, '2250700000000')).rejects.toMatchObject({ written: true });
  expect(smsc.submitted).toHaveLength(1); // the library never resends on its own
});
```

## Authentication and limits

`systemId` and `password` restrict the accepted credentials; `authenticate` replaces them with your own check (e.g. to test a password rotation with `updateBind` and `rebind`). `server` passes any `SmppServer` option (limits, timeouts, logger). `tls: { key, cert }` makes it listen on `ssmpp://`.
