---
title: Receiving messages (MO)
---

# Receiving messages (MO)

Messages sent by users to your number or short code arrive as `deliver_sm`. Bind as `receiver` or `transceiver` to get them.

```ts
const client = new SmppClient({
  url: 'smpp://smsc.example.com:2775',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
});

client.on('message', (msg) => {
  console.log(`${msg.from} → ${msg.to}: ${msg.text}`);
  if (/^stop\b/i.test(msg.text ?? '')) unsubscribe(msg.from);
});
await client.connect();
```

## What you get

| Field | Content |
|---|---|
| `from`, `to` | Sender number, your number or short code |
| `text` | Decoded text (GSM7, Latin-1, UCS2…), `undefined` for binary content |
| `body` | Raw content, without the UDH |
| `parts` | Number of segments it was made of |
| `pdus` | The original PDUs |

## Long messages

Segments are reassembled before `message` is emitted, whatever their order and whether they use a UDH (8 or 16 bits) or SAR TLVs. Incomplete messages are kept for `reassembly.ttl` (5 min) and at most `reassembly.maxBuffers` (1,000) at a time. On expiry, `partialMessage` delivers what arrived, with `missing` listing the absent segments.

## Acknowledgement

Each `deliver_sm` is answered automatically with status 0 (`autoAck: true`). The SMSC then considers it delivered: store the message before doing anything slow. To answer yourself, set `autoAck: false`, listen to `deliver` and call `client.respond()`:

```ts
const client = new SmppClient({ …, autoAck: false });
client.on('deliver', async (pdu) => {
  try {
    await db.saveIncoming(pdu);
    client.respond(pdu);                                                   // status 0
  } catch {
    client.respond(pdu, { command_status: COMMAND_STATUS.ESME_RX_T_APPN }); // the SMSC retries later
  }
});
```

## Receipts are not messages

Delivery receipts also arrive as `deliver_sm`, but they are routed to `deliveryReport` / `messageStatus`, never to `message`.
