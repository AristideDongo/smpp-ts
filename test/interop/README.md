# Interoperability tests

These tests check `smpp-ts` against an SMSC that **is not** the library's own server: bind, `enquire_link`, GSM7 and UCS2 sending, long messages (`udh8`, `udh16`, `sar`), send window and delivery receipts.

They are not part of `npm test`: without `SMPP_INTEROP_URL`, they are skipped.

## Against the Docker simulator

```sh
docker compose -f test/interop/docker-compose.yml up -d --build
SMPP_INTEROP_URL=smpp://127.0.0.1:2775 npm run test:interop
docker compose -f test/interop/docker-compose.yml down
```

## Against your operator's test SMSC

Most operators provide a test account. Run the same suite against it before going to production:

```sh
SMPP_INTEROP_URL=ssmpp://smsc-test.operator.example:3550 \
SMPP_INTEROP_SYSTEM_ID=my_account \
SMPP_INTEROP_PASSWORD=... \
SMPP_INTEROP_FROM=MYSERVICE \
SMPP_INTEROP_TO=+2250700000000 \
npm run test:interop
```

⚠️ Against a real SMSC, SMS messages are actually sent to `SMPP_INTEROP_TO` (about thirty per run). Use a test number you own.

| Variable | Default | Purpose |
|---|---|---|
| `SMPP_INTEROP_URL` | — (tests skipped) | `smpp://host:port` or `ssmpp://host:port` |
| `SMPP_INTEROP_SYSTEM_ID` | `smppts` | Bind identifier |
| `SMPP_INTEROP_PASSWORD` | `secret` | Bind password |
| `SMPP_INTEROP_SYSTEM_TYPE` | — | `system_type`, if the operator requires it |
| `SMPP_INTEROP_FROM` | `SMPPTS` | Sender (alphanumeric or number) |
| `SMPP_INTEROP_TO` | `+2250700000000` | Recipient |
| `SMPP_INTEROP_EXPECT_DLR` | `1` | `0` if the SMSC sends no receipts |
| `SMPP_INTEROP_DLR_TIMEOUT` | `30000` | Maximum wait for receipts (ms) |
| `SMPP_INTEROP_TLS_CA` | — | Path to the CA certificate of an SMSC with a self-signed certificate |

If a test fails against your operator, open an issue with the test output (without credentials): that is exactly the kind of variant the library should handle.
