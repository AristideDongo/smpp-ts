---
"smpp-ts": minor
---

Server hardening:

- Reading pauses while a session's write buffer is full, and a session is closed beyond `maxWriteBuffer` (1 MiB by default): a peer that never reads its responses can no longer grow memory, even before bind (#6).
- Inbound window: at most `inboundWindow` (10) handlers run at the same time per session. `inboundWindowPolicy` chooses between pausing reading (`pause`, default) and answering `ESME_RTHROTTLED` (`throttle`) (#7).
- `maxSessions` and `maxSessionsPerIp` count connections from the moment they are accepted, PROXY header and TLS handshake included. New `handshakeTimeout` (10 s) for the TLS handshake, which used `bindTimeout` (30 s) until now (#8).
- `maxSessionsPerSystemId` can no longer be exceeded by concurrent binds: the slot is reserved before `authenticate()` (#9).
- A handler that returns fields that cannot be encoded gets `ESME_RSYSERR` instead of leaving the request unanswered.

Client:

- `AbortSignal` on every request (`signal` option) and on `sendText`. New `SmppAbortError` with `written`.
- `multipart.maxSegments` and the per-call `maxSegments` option cap the segments of a `sendText`.
- `flash: true` in `sendText` sends a flash SMS (message class 0).
