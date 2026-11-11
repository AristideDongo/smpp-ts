---
"smpp-ts": patch
---

Server: in-flight handlers and `authenticate()` share one `close` listener per session to drive their `AbortSignal`. With the default `inboundWindow` of 10, Node no longer prints `MaxListenersExceededWarning` on every burst of requests.
