# Interoperability tests

These tests check `smpp-ts` against an SMSC that **is not** the library's own server: bind, `enquire_link`, GSM7 and UCS2 sending, long messages (`udh8`, `udh16`, `sar`), send window and delivery receipts.

They are not part of `npm test`: without `SMPP_INTEROP_URL`, they are skipped.

## Compatibility matrix

| Peer | Priority | Language | Role | What is tested | Status |
|---|---|---|---|---|---|
| [Jasmin](https://github.com/jookies/jasmin) 0.11.0 | 1, target integration | Python | real SMS gateway (smpp-ts is the client; Jasmin relays to an upstream SMSC played by smpp-ts) | binds, `submit_sm`, GSM7 / UCS2 / national tables, long messages, receipts, message id formats, MO, errors, throttling, network cuts: [jasmin/README.md](jasmin/README.md) | ✅ |
| [smscsim](https://github.com/ukarim/smscsim) | automated tests | Go | SMSC simulator (smpp-ts is the client) | `smsc.interop.ts`: bind, `enquire_link`, GSM7 / UCS2, long messages (`udh8`, `udh16`, `sar`), window, receipts | ✅ |
| [jsmpp](https://github.com/opentelecoms-org/jsmpp) 3.0.2 | interoperability | Java | SMSC (smpp-ts is the client) | same suite, against `servers/JsmppSmsc.java` | ✅ |
| [python-smpplib](https://github.com/python-smpplib/python-smpplib) 2.2.4 | interoperability | Python | client (smpp-ts is the server) | `server.interop.ts`: bind, short GSM7 and long UCS2 split by the peer, receipts, MO, unbind | ✅ |
| [gosmpp](https://github.com/linxGnu/gosmpp) 0.3.1 | interoperability | Go | client (smpp-ts is the server) | same scenario | ✅ |
| [Kannel](https://www.kannel.org/) | complementary | C | client (smpp-ts would be the server) | — | not covered yet |
| [@larvit/smpp](https://www.npmjs.com/package/@larvit/smpp) | comparative reference | TypeScript | — | feature comparison only ([docs/guides/comparison.md](../../docs/guides/comparison.md)); no test, to keep it out of the dependencies | — |

✅ = passes locally and in CI. The jsmpp jars are downloaded from Maven Central and checked against a SHA-256.

## Server side: a third-party client against `SmppServer`

`server.interop.ts` starts an `SmppServer`, then runs the command in `SMPP_INTEROP_CLIENT` with `<host> <port>` appended. The client follows `clients/expected.json` and prints a JSON summary on its last line.

```sh
pip install smpplib==2.2.4
SMPP_INTEROP_CLIENT="python3 test/interop/clients/python_smpplib.py" npm run test:interop

(cd test/interop/clients/gosmpp && go build -o gosmpp-client .)
SMPP_INTEROP_CLIENT=test/interop/clients/gosmpp/gosmpp-client npm run test:interop
```

## Against jsmpp (Java 11+, no Maven needed)

```sh
curl -sSfLo jsmpp.jar https://repo1.maven.org/maven2/org/jsmpp/jsmpp/3.0.2/jsmpp-3.0.2.jar
curl -sSfLo slf4j-api.jar https://repo1.maven.org/maven2/org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar
java -cp jsmpp.jar:slf4j-api.jar test/interop/servers/JsmppSmsc.java 2775 &
SMPP_INTEROP_URL=smpp://127.0.0.1:2775 npm run test:interop
```

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
