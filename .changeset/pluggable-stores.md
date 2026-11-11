---
"smpp-ts": minor
---

Pluggable storage interfaces (no storage shipped: the application implements them).

- `trackDeliveries: { store }`: a `DeliveryTrackerStore` (`save`, `delete`, `load`) receives every change of the tracked messages. A client reloads it before its first bind, so tracking survives a restart. `DeliveryTracker.restore()` for standalone use. Store errors are logged and tracking goes on in memory.
- `sequenceGenerator: { next() }`: source of `sequence_number` values.
- `concatReference: () => number`: source of long-message concatenation references (client and pool).
