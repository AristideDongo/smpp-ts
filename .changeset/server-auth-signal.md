---
"smpp-ts": minor
---

Server: safer authentication and handler cancellation.

- `authenticate()` binds the session only when it returns `true` or an object. `0`, `''`, `NaN` and any other value are refusals (#23).
- Only refusals by `authenticate()` count toward the IP ban. A session limit answers `ESME_RBINDFAIL` without counting; a timeout or exception in `authenticate()` answers `ESME_RSYSERR` without counting. `bindFailed` carries a `reason`: `credentials`, `limit`, `timeout` or `error` (#24).
- Handlers receive a third argument `{ signal }`, and `authenticate()` a `signal` field: aborted when `handlerTimeout` expires or the session closes, so late work can be rolled back instead of duplicating a message (#25).
