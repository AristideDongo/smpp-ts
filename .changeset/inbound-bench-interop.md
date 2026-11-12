---
"smpp-ts": minor
---

Faster client, bounded manual acknowledgement, three more interoperability peers.

- **`maxPendingInbound`** (1,000 by default): with `autoAck: false`, incoming `deliver_sm` / `data_sm` waiting for `respond()` are bounded per session; beyond, they are answered at once with `ESME_RX_T_APPN` (the SMSC delivers them again later) and not emitted. `client.pendingInboundCount`, `pool.respond(pdu)` and `pool.pendingInboundCount`.
- **`respond()` answers on the session the PDU arrived on.** After a reconnection, answering a PDU of the old session no longer sends a response with a stale `sequence_number` on the new one (it could acknowledge another message).
- **Throughput**: the writes of one batch leave in one system call (`cork` / `uncork`), the send queue is O(1), TLV encoding looks only at the parameters given. Against an SMSC in another process: about 60,000 `submit_sm`/s at window 10 and 90,000 at window 100 on a 2017 laptop CPU (2.3 to 3 times the previous release); `submit_sm` encoding 3.5 times faster. Bytes on the wire are unchanged.
- `DeliveryTrackerStore.save` / `delete` may return any value (a Redis or SQL call can be returned as it is); a rejected Promise is still logged.
- Interoperability tested in CI against Kannel 1.4.5 (smpp-ts server, via `sendsms`, `dlr-url` and `get-url`), Cloudhopper SMPP 5.0.9 (smpp-ts client) and php8-smpp 0.1.1 (smpp-ts server), on top of Jasmin, smscsim, jsmpp, python-smpplib and gosmpp.
- Every TypeScript example of the README and the guides is type-checked against the API in the test suite.
- New guides: migration plan, design decisions.
