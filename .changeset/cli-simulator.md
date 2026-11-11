---
"smpp-ts": minor
---

Command line `smpp-ts` (`npx smpp-ts …`), with no dependency:

- `smpp-ts smsc`: SMSC simulator (credentials, receipts `delivered` / `undeliverable` / `random` / `none` with a delay, `--echo` MO, TLS). Listens on 127.0.0.1 by default.
- `smpp-ts send`: sends an SMS, prints the message ids, and with `--dlr` waits for the final receipt (exit code 0 if delivered). `--ca` trusts a self-signed certificate without disabling verification.
