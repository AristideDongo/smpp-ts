---
"smpp-ts": minor
---

Suivi des accusés multi-segments : option `trackDeliveries` et événement `messageStatus` (`DELIVERED`, `FAILED`, `PARTIALLY_DELIVERED`, `TIMEOUT`), avec `reference` applicative. Classe `DeliveryTracker` exportée pour un usage autonome. Mémoire bornée (`maxTracked`, `ttl`).
