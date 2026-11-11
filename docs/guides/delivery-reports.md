---
title: Delivery receipts
---

# Delivery receipts

Ask for a receipt with `registeredDelivery: true`. The SMSC answers later with a `deliver_sm` that the library turns into a `DeliveryReport`.

```ts
client.on('deliveryReport', (dlr) => {
  // dlr.messageId, dlr.status, dlr.errorCode, dlr.doneDate…
});
```

## Statuses

| `status` | Final | Meaning |
|---|---|---|
| `DELIVERED` | yes | Delivered to the handset |
| `UNDELIVERABLE` | yes | Will not be delivered (`stat:UNDELIV`, `stat:FAILED`) |
| `EXPIRED` | yes | Validity period over |
| `REJECTED` | yes | Refused by the network |
| `DELETED`, `UNKNOWN`, `SKIPPED` | yes | |
| `ACCEPTED`, `ENROUTE` | no | Intermediate notification |

`rawStatus` keeps the value as received. When the SMSC sends both the TLVs (`receipted_message_id`, `message_state`) and the text, the TLVs win.

## One outcome per message

A long message has one receipt per segment. With `trackDeliveries`, the library groups them:

```ts
const client = new SmppClient({ …, trackDeliveries: true });
client.on('messageStatus', (s) => {
  // s.outcome: DELIVERED | FAILED | PARTIALLY_DELIVERED | TIMEOUT, s.reference, s.reports
});
```

## Ids that do not match

Some SMSCs return the id in decimal in `submit_sm_resp` and in hexadecimal in the receipt, or the other way round. `messageIdFormat: 'hex-to-dec'` (or `'dec-to-hex'`) normalizes the receipt id; `rawMessageId` keeps the original.

## Formats

The parser accepts the usual variants: `Text:` with a capital T, 12-digit dates, lowercase statuses, missing `err:` or `text:`, receipt in `message_payload`, UUID ids… Each variant is covered by a fixture in `test/fixtures/`.
