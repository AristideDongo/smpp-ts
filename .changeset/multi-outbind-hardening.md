---
"smpp-ts": minor
---

`submit_multi` and `outbind` at the high level, a soak test, and a hardened repository.

- **`sendTextMulti({ from, to: [...], text })`**: one text to up to 254 numbers and/or distribution lists (`{ list: 'name' }`) with `submit_multi`, one PDU per segment whatever the number of destinations. Encoding, splitting, normalization, addresses, `flash`, priority and retries work as in `sendText`. Destinations the SMSC refuses do not fail the call: they are listed in `refused` with their status. Also on `SmppPool`.
- **`OutbindServer`**: SMSC-initiated sessions. The SMSC connects, sends `outbind`, `authenticate()` checks its credentials, and the library binds as `receiver` on that connection (or the mode given). Each accepted connection is an ordinary bound `SmppClient` handed to the `session` event. TLS, `outbindTimeout`, `maxSessions`, and the same answer whatever the refusal reason.
- **`socket` option of `SmppClient`**: binds on an already open connection (received by `OutbindServer`, or opened through a proxy). Bound once: reconnection is off.
- Codec: empty C-Octet strings are read without a search or an allocation (most optional fields are empty).
- Tests: coverage thresholds now also lock `client/`, `server/` and `transport/`; opt-in soak test (`npm run soak`) checks that memory stays flat across 200,000 messages, their receipts and 20 disconnections; Windows and macOS in CI.
- Repository: GitHub Actions pinned by commit, CodeQL, Dependabot, documentation site published by CI on every push to `main`, private vulnerability reporting (SECURITY.md), issue templates (bug, operator variant, feature), code of conduct.
- Guides: troubleshooting (every error and status, with what to do) and known operator variants.
