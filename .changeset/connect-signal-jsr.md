---
"smpp-ts": minor
---

- `connect({ signal })` on `SmppClient` and `SmppPool`: aborts the TCP/TLS connection or the bind with `SmppAbortError`.
- Published on JSR as `@smpp-ts/smpp-ts` (`deno add jsr:@smpp-ts/smpp-ts`). `jsr.json` follows the npm version.
- Explicit return types on `query`, `cancel`, `replace`, `defaultCodec`, `encodings` and `SmppServer.sessions`.
