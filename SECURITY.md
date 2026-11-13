# Security policy

## Supported versions

Only the latest published minor version receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Report it privately through
[GitHub security advisories](https://github.com/AristideDongo/smpp-ts/security/advisories/new):
only the maintainers see the report until a fix is published.

Expect an acknowledgement within 7 days. The fix is released as a patch version, with a security
advisory and a CHANGELOG entry crediting you, unless you prefer to stay anonymous.

To help us handle it quickly, include:

- the affected version (`npm ls smpp-ts`) and your Node version;
- a description of the problem and its impact;
- a way to reproduce it: PDU in hexadecimal, minimal script…;
- if possible, a suggested fix.

**Never post real credentials** (system_id, password, production SMSC address) or real subscribers'
phone numbers in a report, an issue or a PR. Mask them before sharing logs or PDU captures.

Ordinary bugs (no security impact) go to the [issues](https://github.com/AristideDongo/smpp-ts/issues).

## Design guarantees

- TLS verification on by default, TLS 1.2 minimum.
- Passwords are never logged: not in logs, events or error messages.
- Every field is validated against the specification, both when sending and when receiving.
- The parser is fuzz-tested (1 million iterations in CI) and only throws typed errors.
- Bounded resources: PDU size, send window, queue, reassembly buffers, sessions, pending inbound PDUs.
- Server: authentication with constant-time comparison helper, same answer whether the account
  exists or not, bind failure limiter per IP, Proxy Protocol only from trusted CIDRs.
- No runtime dependencies. GitHub Actions pinned by commit, CodeQL and OpenSSF Scorecard in CI,
  `npm audit` on every build.
