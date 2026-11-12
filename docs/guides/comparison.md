---
title: Comparison with other SMPP libraries
---

# Comparison with other SMPP libraries

How smpp-ts compares with other maintained SMPP libraries, to help you choose. Last reviewed **November 2026**, from each project's README and documentation. Libraries evolve: if something here is out of date or wrong, please open an issue or a pull request.

✅ built in · ❌ not available · — not documented (it may exist; we found no mention of it)

| | smpp-ts | @larvit/smpp | jsmpp | Cloudhopper | gosmpp | python-smpplib |
|---|---|---|---|---|---|---|
| Language | TypeScript | TypeScript | Java | Java | Go | Python |
| Client / server | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ❌ | ✅ / ❌ |
| SMPP versions | 3.4, 5.0 | 3.4 | 3.3, 3.4, 5.0 | 3.3, 3.4, most of 5.0 | 3.4 | — |
| Reconnect and re-bind | ✅ | ✅ | — | — | ✅ | — |
| Send window | ✅ | ✅ | — | ✅ | ✅ | — |
| Split long messages | ✅ | ✅ | — | — | ✅ | ✅ |
| Reassemble incoming long messages | ✅ | ✅ | — | — | ❌ (example code) | — |
| Delivery receipt parsing | ✅ | ✅ | ✅ | — | — | — |
| One outcome per multipart message | ✅ | ✅ | — | — | — | — |
| GSM7 normalization (avoid UCS2 billing) | ✅ | — | — | — | — | — |
| Cost estimate before sending | ✅ | — | — | — | — | — |
| Priority send queue | ✅ | — | — | — | — | — |
| Drops receipts / messages sent again | ✅ | — | — | — | — | — |
| In-process test SMSC with fault injection | ✅ | — | — | — | — | — |
| Several binds behind one API | ✅ | ❌ (planned) | — | — | — | — |
| TLS certificate verified by default | ✅ | TLS off by default | — | — | — | — |
| Server: authentication required | ✅ | accepts every bind by default | — | — | n/a | n/a |
| Proxy Protocol v1/v2 | ✅ | — | — | — | — | — |
| Metrics / OpenTelemetry | ✅ / ✅ | — | — | counters | — | — |
| Typed errors with "was it sent?" | ✅ | `{ err }` results | exceptions | exceptions | callbacks | exceptions |
| Parser fuzzing | 1M iterations | — | — | — | — | — |
| Runtime dependencies | 0 | 0 | slf4j | Netty and others | a few Go modules | `six` |

## When another library fits better

- **Your stack is Java, Go or Python**: use the library of your language. jsmpp and Cloudhopper are mature and widely deployed; gosmpp and python-smpplib are simple and well known.
- **You need a full SMS gateway** (routing, billing, HTTP API, store and forward): look at a gateway such as Jasmin or Kannel rather than a library.

## Sources

- [@larvit/smpp](https://github.com/larvit/smpp-js)
- [jsmpp](https://github.com/opentelecoms-org/jsmpp)
- [Cloudhopper SMPP](https://github.com/fizzed/cloudhopper-smpp)
- [gosmpp](https://github.com/linxGnu/gosmpp)
- [python-smpplib](https://github.com/python-smpplib/python-smpplib)
