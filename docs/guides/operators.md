---
title: Known operator variants
---

# Known operator variants

SMSCs do not all read the specification the same way. This page lists the differences met in
practice, grouped by theme, with the option that handles each one. It grows with the
[operator variant issues](https://github.com/AristideDongo/smpp-ts/issues/new?template=operator_variant.yml)
and the anonymized captures in `test/fixtures/` (see `test/fixtures/README.md` for the anonymizer):
if your operator does something not listed here, that is the place to report it.

The behaviours below are those of the implementations tested in CI (Kannel, Jasmin, jsmpp,
Cloudhopper, smscsim, python-smpplib, gosmpp, php8-smpp) and of variants reported by users. An
operator is named only when its behaviour has been confirmed from a capture.

## Delivery receipts

| Variant | Seen with | Handling |
|---|---|---|
| Receipt text `id:… sub:… dlvrd:… submit date:… done date:… stat:… err:… text:…` | Most SMSCs (SMPP 3.4 appendix B) | Parsed by default |
| Fields in another order, missing fields, extra fields (`dlvrd` absent, `err` with 3 digits, lowercase `stat`) | Jasmin, Kannel, home-grown SMSCs | Tolerated: the parser reads field by field, unknown fields go to `fields` |
| `stat` values beyond the 7 standard ones (`DELIVRD`, `EXPIRED`, `DELETED`, `UNDELIV`, `ACCEPTD`, `UNKNOWN`, `REJECTD`), for example `ENROUTE` or `DELIVERED` | Several operators | Normalized; anything unknown gives `status: 'UNKNOWN'` with `rawStatus` kept |
| Receipt carried by TLVs (`receipted_message_id`, `message_state`, `network_error_code`) with an empty text | SMPP 5.0 SMSCs, Cloudhopper | TLVs take priority over the text |
| Receipt as `data_sm` instead of `deliver_sm` | Some SMPP 5.0 SMSCs | Both are handled (`deliveryReport` event in both cases) |
| `esm_class` without the receipt bit (`0x04`) but a `receipted_message_id` TLV | Some gateways | Treated as a receipt |
| Receipt dates in `YYMMDDhhmm` (10 digits) or `YYMMDDhhmmss` (12 digits) | Both exist | Both parsed |
| Several receipts for one message (`ACCEPTD` then `DELIVRD`) | Most operators | Each one is an event; `trackDeliveries` gives one final `messageStatus` |
| The same final receipt sent twice | After a reconnection, or SMSC retry | Dropped (`duplicate` event) with the default `dedup` |

## Message ids

| Variant | Handling |
|---|---|
| Decimal id in `submit_sm_resp`, hexadecimal in the receipt (`id:1A2B`) | `messageIdFormat: 'hex-to-dec'` |
| Hexadecimal id in `submit_sm_resp`, decimal in the receipt | `messageIdFormat: 'dec-to-hex'` |
| Ids with leading zeros dropped on one side | Compared after the conversion above; `rawMessageId` keeps the original |

## Long messages

| Variant | Handling |
|---|---|
| Only UDH concatenation accepted (`esm_class` UDHI bit) | Default (`strategy: 'udh8'`) |
| UDH refused with `ESME_RINVESMCLASS`, SAR TLVs expected | `strategy: 'sar'` |
| One PDU with `message_payload` expected (SMSC splits itself) | `strategy: 'payload'` |
| 16-bit concatenation reference expected | `strategy: 'udh16'` |
| Kannel-style UDHI (`esm_class` bit `0x40` only, no `0x03` type) | Both bits are tested on receipt (BUG-04 regression test) |
| Incoming segments with the UDH but `data_coding` UCS2 | Decoded as UCS2 after the UDH (BUG-05 regression test) |
| Segments arriving out of order, or over several binds of a pool | Reassembled by (`source`, `destination`, reference); a pool shares one reassembly buffer |

## Encodings

| Variant | Handling |
|---|---|
| `data_coding` 0 meaning Latin-1 (or UCS2) instead of GSM7 | `new EncodingRegistry().mapDataCoding(0, 'latin1')` given as `encodings` |
| GSM7 sent packed (septets) instead of one octet per character | `packedGsm7: true` on receipt, `multipart: { packGsm7: true }` when sending |
| Latin-1 refused (`ESME_RINVDCS`) | `multipart: { allowLatin1: false }` (the default): GSM7 or UCS2 only |
| National language shift tables (Turkish, Spanish, Portuguese…) | `shift` / `locking` options, `multipart.shiftTables` to let detection use them |
| `data_coding` 0x01 (IA5/ASCII) used for GSM7 | Mapped to GSM7 by default |
| Flash SMS through `data_coding` message class bits | `flash: true` |

## Addresses

| Variant | Handling |
|---|---|
| Destination TON/NPI must be `1/1` (international) | Default for a number starting with `+` or `00`; `destTon`, `destNpi` to force |
| Destination TON/NPI must be `0/1` or `0/0` whatever the format | `destTon: 0`, `destNpi: 0` |
| Alphanumeric sender refused unless TON is `5` | Default for an alphanumeric `from` |
| Alphanumeric sender refused unless TON is `0` | `sourceTon: 0` |
| Sender longer than 11 characters accepted | `address: { maxAlphanumericLength: 15 }` |
| International prefix other than `00` (`011` in North America) | `address: { internationalPrefix: '011' }` |

## Binds and sessions

| Variant | Handling |
|---|---|
| Separate accounts (or separate ports) for sending and receiving | Two clients (`transmitter` + `receiver`) or a `SmppPool` with `members` |
| `system_type` required (`VMA`, `OTA`, a customer code…) | `bind.system_type` |
| `interface_version` 0x50 refused | The default is 0x34; set `interface_version: 0x50` only for SMPP 5.0 features (`congestion_state`, `broadcast_sm`) |
| Bind refused when `address_range` is empty | `bind.address_range` |
| Session dropped after 60 s without traffic | `enquireLinkInterval: 30_000` (the default) keeps it alive; lower it if the operator's timeout is shorter |
| `enquire_link` from the SMSC every few seconds | Answered automatically; it counts as traffic |
| SMSC-initiated sessions (`outbind`) | `OutbindServer` |
| Only one bind per account (`ESME_RALYBND` on a second one) | Wait for the SMSC to expire the old session after a crash; a graceful `close()` unbinds first |
| `submit_sm_resp` with an empty body on error | Tolerated (lenient parsing of responses) |
| `generic_nack` instead of a typed response | Matched by `sequence_number`: the request fails with a `SmppStatusError` carrying its status |

## Rate and flow control

| Variant | Handling |
|---|---|
| Contractual rate (10, 50, 500 msg/s) enforced with `ESME_RTHROTTLED` | `rateLimit: { perSecond }` just below the contract; the limiter also slows down by itself after a throttle |
| Window larger than 1 refused (one request at a time) | `window: 1` |
| `congestion_state` TLV in responses (SMPP 5.0) | Slows the rate limiter down from `congestionThreshold` (90 by default) |
| `ESME_RMSGQFUL` under load | Retried with backoff like `ESME_RTHROTTLED` |

## Tested implementations

| Implementation | Role in CI | What the suite checks |
|---|---|---|
| Kannel 1.4.5 | SMPP client of the smpp-ts server | Bind, short GSM7 and long UCS2 messages, receipts through `dlr-url`, MO through `get-url`, clean unbind |
| Jasmin 0.11 | SMSC between an smpp-ts client and an smpp-ts upstream | Receipt text format, hex id in `submit_sm_resp` and decimal in the receipt, Turkish shift table, UCS2 split, throttling with retry, cuts on both sides |
| jsmpp 3.0, Cloudhopper 5.0, smscsim | SMSC for the smpp-ts client | Bind and unbind, `enquire_link`, a window of concurrent requests |
| python-smpplib 2.2, gosmpp, php8-smpp 0.1 | Clients of the smpp-ts server | Bind, short and long (UCS2, concatenated) messages, receipts, MO, unbind |
