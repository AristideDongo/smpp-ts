# Compatibility suite: Jasmin

[Jasmin](https://github.com/jookies/jasmin) 0.11.0 is an open-source SMS gateway used in production by many operators and aggregators. This suite runs `smpp-ts` against a real Jasmin instance, not a simulator.

```
smpp-ts SmppClient ──SMPP──▶ Jasmin (SMPP server :2775) ──SMPP──▶ UpstreamSmsc
                             jCli :8990                           (smpp-ts SmppServer, run by the test)
```

The test configures Jasmin itself through jCli (users, connectors, filters, routes) and plays the operator SMSC behind it. That way it controls what a real operator would decide: message ids, receipt statuses, throttling, MO traffic, network cuts.

## Run

```sh
docker compose -f test/interop/jasmin/docker-compose.yml up -d --wait
npm run test:jasmin
docker compose -f test/interop/jasmin/docker-compose.yml down -v
```

Runs in CI on every pull request (`interop (jasmin)` job, about 2 minutes).

| Variable | Default | Purpose |
|---|---|---|
| `JASMIN_SMPP_HOST`, `JASMIN_SMPP_PORT` | `127.0.0.1`, `2775` | Jasmin's SMPP server |
| `JASMIN_JCLI_HOST`, `JASMIN_JCLI_PORT` | `127.0.0.1`, `8990` | jCli (login `jcliadmin` / `jclipwd`) |
| `JASMIN_UPSTREAM_PORT` | `2776` | Port of the upstream SMSC on the test machine |
| `JASMIN_UPSTREAM_HOST` | `host.docker.internal` | The test machine, as seen from the Jasmin container |

## What is covered

| Area | Scenario | Result |
|---|---|---|
| Binds | `transmitter`, `receiver`, `transceiver`, `enquire_link`, `unbind` | ✅ |
| | Wrong password, unknown `system_id` | ✅ `ESME_RINVPASWD` for both |
| | `submit_sm` on a receiver bind | ✅ refused locally (SEC-07) |
| `submit_sm` | GSM7, GSM7 extension table (`€ [ ] { } ~ ^ \| \`), GSM7 accented letters | ✅ byte-identical upstream |
| | UCS2 (emoji / surrogate pairs, Arabic) | ✅ |
| | Turkish national single shift (UDH IE `0x24`) | ✅ |
| Long messages | GSM7 with `udh8`, `udh16`, `sar`; UCS2 with `udh8` | ✅ reassembled upstream |
| | `message_payload` | ⚠️ Jasmin limitation, see below |
| Receipts | `DELIVRD`, `UNDELIV`, `EXPIRED` relayed with Jasmin's id | ✅ |
| | Receipts of every part of a long message aggregated (`messageStatus`) | ✅ |
| | Receipts of a transmitter bind delivered to a receiver bind of the same account | ✅ |
| Message ids | Jasmin returns its own UUID, never the upstream id | ✅ |
| | Upstream hex in `submit_sm_resp`, decimal in the receipt (`dlr_msgid 1`) | ✅ mapped back by Jasmin |
| MO | Short `deliver_sm`, concatenated UCS2 `deliver_sm` | ✅ reassembled by the client |
| Errors | Destination outside the account filter | ✅ `ESME_RINVDSTADR` |
| Throttling | Over the account throughput (`smpps_throughput`) | ✅ `ESME_RTHROTTLED`; with `retry`, every message ends up accepted |
| | `ESME_RTHROTTLED` from the upstream SMSC | ✅ retried by Jasmin, invisible to the ESME |
| Network | Client ↔ Jasmin cut: in-flight requests rejected with `SmppConnectionClosedError`, automatic reconnect and re-bind | ✅ |
| | Jasmin ↔ upstream cut: message queued, delivered once the connector is back | ✅ |

## Jasmin behaviour worth knowing

Found while building this suite, against Jasmin 0.11.0:

- **Bind refusals** answer `ESME_RINVPASWD`, also for an unknown `system_id` (no account enumeration). `smpp-ts` reports it as a `SmppStatusError` like any other bind failure.
- **Asynchronous submit.** Jasmin answers `submit_sm_resp` as soon as the message is queued. An error from the upstream SMSC never reaches the ESME as a status: ask for a receipt (`registeredDelivery`) to learn the outcome.
- **`message_payload` is not relayed.** Jasmin accepts a `submit_sm` carrying `message_payload`, then fails to re-encode it towards the upstream connector (`Value … size N does not match expected 1` in `messages.log`) and drops it. Use the default `udh8` strategy (or `udh16`, `sar`) with Jasmin. The test asserts this limitation, so it will flag a Jasmin release that fixes it.
- **Upstream throttling blocks the connector.** By default Jasmin retries an upstream `ESME_RTHROTTLED` every 30 s, up to 20 times (`submit_error_retrial` in `jasmin.cfg`), and the connector's queue waits meanwhile. The suite routes that scenario through its own connector.
- **Restarting a connector during its reconnect loop** (stop then start while the SMSC is unreachable) can make Jasmin reject the next queued message with an `AttributeError`. The suite stops its connectors at the end of a run and warms each route up before testing.
