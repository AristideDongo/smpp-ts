# Migration guide

This guide helps you move from a callback-based Node.js SMPP library (a single `Session` class, sending with `session.submit_sm(params, callback)`) to `smpp-ts`.

## Connecting and binding

Before:

```js
const session = smpp.connect({ url: 'smpp://smsc:2775', auto_enquire_link_period: 30000 }, () => {
  session.bind_transceiver({ system_id: 'xxx', password: 'yyy' }, (pdu) => {
    if (pdu.command_status !== 0) { /* … */ }
  });
});
```

After:

```ts
const client = new SmppClient({
  url: 'smpp://smsc:2775',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  enquireLinkInterval: 30_000,
});
await client.connect(); // rejects with SmppStatusError if the bind is refused
```

Keepalive is on by default and a dead connection is detected (`enquireLinkTimeout`). Reconnection with re-bind is automatic.

## Sending

Before: three callbacks (response, sent, failure), and no notification at all if the SMSC never answers.

```js
session.submit_sm({ destination_addr: '…', short_message: 'Hello' }, (pdu) => {
  if (pdu.command_status === 0) console.log(pdu.message_id);
});
```

After: a Promise that always settles, with a response, an error or a timeout.

```ts
const { message_id } = await client.submit({ destination_addr: '…', short_message: 'Hello' });
// or, with automatic encoding and splitting:
const { messageIds } = await client.sendText({ to: '…', from: '…', text: 'Hello' });
```

Per-command shortcuts are still available under `client.raw`: `client.raw.submit_multi({ … })`, `client.raw.data_sm({ … })`…

## Behaviour differences

| Topic | Before | `smpp-ts` |
|---|---|---|
| TLS | Certificate not verified by default | **Verified**; use `tls.ca` for a self-signed certificate |
| Silent SMSC | Waits forever | `SmppTimeoutError` after `requestTimeout` |
| Network outage | Callbacks lost | `SmppConnectionClosedError` with `written` |
| Unhandled `error` event | Process exits | Sent to the logger |
| Invalid PDU received | Processing stops | `generic_nack`, the session goes on |
| Debug logs | Full PDUs, password included | Password always masked |
| Sending before bind | Possible | `SmppStateError` |
| Text `short_message` | Unrepresentable characters silently replaced | Error if a forced encoding cannot represent the text |
| Sender / recipient | Sent as given | Normalized and validated (`+`, `00`, separators, 11-char alphanumeric sender) |

## Receiving

```ts
client.on('deliver', (pdu) => { /* raw PDU */ });
client.on('deliveryReport', (dlr) => { /* { messageId, status: 'DELIVERED' | … } */ });
client.on('message', (msg) => { /* MO, segments already reassembled */ });
```

`deliver_sm_resp` is sent automatically. With `autoAck: false`, answer yourself with `client.respond(pdu, { command_status })`.

## Server

Before: the `session` and `bind_transceiver` events, then `session.send(pdu.response())`.

After:

```ts
new SmppServer({
  authenticate: ({ system_id, password }) => …,  // required
  handlers: { submit_sm: (pdu) => ({ message_id: '…' }) },
});
```

## Proxy Protocol

No external dependency and no more patching of `socket.emit`. Versions v1 and v2 are handled internally, and the list of trusted proxies is required:

```ts
new SmppServer({ …, proxyProtocol: { trustedProxies: ['10.0.0.0/8'] } });
```
