# Security policy

## Supported versions

Only the latest published minor version receives security fixes.

## Reporting an issue

Found a bug or a vulnerability? Open an [issue](https://github.com/AristideDongo/smpp-ts/issues) or send a fix directly as a [pull request](https://github.com/AristideDongo/smpp-ts/pulls).

To help us handle it quickly, include:

- the affected version (`npm ls smpp-ts`) and your Node version;
- a description of the problem and its impact;
- a way to reproduce it: PDU in hexadecimal, minimal script…;
- if possible, a suggested fix.

**Never post real credentials** (system_id, password, production SMSC address) or real subscribers' phone numbers in an issue or a PR. Mask them before sharing logs or PDU captures.

You will be credited for the finding in the CHANGELOG, unless you prefer to stay anonymous.

## Design guarantees

- TLS verification on by default, TLS 1.2 minimum.
- Passwords are never logged: not in logs, events or error messages.
- Every field is validated against the specification, both when sending and when receiving.
- The parser is fuzz-tested and only throws typed errors.
- Bounded resources: PDU size, send window, queue, reassembly buffers, sessions.
- No runtime dependencies.
