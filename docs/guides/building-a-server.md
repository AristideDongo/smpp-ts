---
title: Building an SMPP server
---

# Building an SMPP server

`SmppServer` lets you expose your own SMPP endpoint: an SMS gateway for your customers, a test SMSC, a protocol bridge.

```ts
import { SmppServer, safeCompare, COMMAND_STATUS } from 'smpp-ts';

const server = new SmppServer({
  authenticate: async ({ system_id, password, remoteAddress }) => {
    const account = await db.accounts.find(system_id);
    if (!account || !safeCompare(password, account.password)) return false;
    return { accountId: account.id };   // available as session.context
  },
  handlers: {
    submit_sm: async (pdu, session, { signal }) => {
      if (!isValidNumber(pdu.destination_addr)) return COMMAND_STATUS.ESME_RINVDSTADR;
      // signal: aborted if the answer was already sent (timeout) or the session closed
      const id = await queue.push({ account: session.context!.accountId, pdu }, { signal });
      return { message_id: id };
    },
  },
  tls: { key, cert },
});
await server.listen(3550);
```

## Authentication

- `authenticate` is required. It binds the session **only** when it returns `true` or an object (which becomes `session.context`). Anything else, including `0`, `''` or `NaN` (for example a database column `enabled = 0` short-circuiting `row && row.enabled && …`), is a refusal: `ESME_RBINDFAIL`, whether the account exists or not.
- An exception, or no answer within `handlerTimeout`, answers `ESME_RSYSERR`: the backend is down, not the password wrong, so the client retries. `ctx.signal` is aborted on timeout.
- `safeCompare` compares in constant time.
- Repeated refusals by `authenticate()` ban the IP for a while (`bindFailures`). Session limits (`maxSessionsPerSystemId`), timeouts and exceptions do not count. Brute force on one account from many addresses must be handled in `authenticate()`.
- The `bindFailed` event carries a `reason`: `credentials`, `limit`, `timeout` or `error`.

## Handlers

- A handler returns nothing (status 0), a number (`command_status`) or the response fields.
- An exception with a `status` gives that status; any other exception, or no answer within `handlerTimeout` (10 s), gives `ESME_RSYSERR`.
- A command without a handler gets `ESME_RINVCMDID`.
- The third argument is `{ signal }`. It is aborted when `handlerTimeout` expires (the client already received `ESME_RSYSERR`) or when the session closes; `signal.reason` is a `SmppError` with code `SMPP_HANDLER_TIMEOUT` or `SMPP_SESSION_CLOSED`.
- Work finishing after the timeout is **not** reported to the client, which usually resends on `ESME_RSYSERR`. Make handlers idempotent, or check `signal.aborted` (or pass `signal` on) before committing, to avoid sending the same SMS twice.

## Sending to customers

```ts
await server.deliver('customer-system-id', { source_addr: '…', destination_addr: '…', short_message: Buffer.from('…') });
await session.deliverReceipt({ messageId, status: 'DELIVERED', source, destination });
```

`deliver` picks a `receiver` or `transceiver` session of that `system_id` in turn.

## Protection

| Option | Default | Effect |
|---|---|---|
| `bindTimeout` | 30 s | Closes a session that does not bind |
| `idleTimeout` | 5 min | Closes a silent bound session |
| `maxSessions`, `maxSessionsPerIp` | 1,000, 50 | Counted from the moment a connection is accepted |
| `maxSessionsPerSystemId` | 10 | Binds still being authenticated included |
| `inboundWindow` | 10 | Handlers running at once per session (`pause` or `throttle`) |
| `maxWriteBuffer` | 1 MiB | Closes a session that never reads its responses |
| `proxyProtocol` | off | PROXY v1/v2 from `trustedProxies` only |
