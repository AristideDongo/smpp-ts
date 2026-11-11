---
"smpp-ts": minor
---

`SmppPool`: several binds behind the `SmppClient` API.

- `size` identical binds, or `members` with per-bind options (another host, another `system_id`…).
- `least-busy` (default) or `round-robin` strategy; `minBound` binds required by `connect()`.
- Failover: sends go through the other binds while one reconnects. A send that was not written moves to another bind; a written one is never resent.
- Receipts (`messageStatus`) and multipart incoming messages work whatever bind they arrive on. Concatenation references are shared, so two binds never use the same one at the same time.
- Events `memberUp` and `memberDown`.

`InboundProcessor` (receipt and incoming message handling, reassembly) is exported for advanced use.
