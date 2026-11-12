# Interoperability tests

These tests check `smpp-ts` against an SMSC that **is not** the library's own server: bind, `enquire_link`, GSM7 and UCS2 sending, long messages (`udh8`, `udh16`, `sar`), send window and delivery receipts.

They are not part of `npm test`: without `SMPP_INTEROP_URL`, they are skipped.

## Compatibility matrix

| Peer | Priority | Language | Role | What is tested | Status |
|---|---|---|---|---|---|
| [Jasmin](https://github.com/jookies/jasmin) 0.11.0 | 1, target integration | Python | real SMS gateway (smpp-ts is the client; Jasmin relays to an upstream SMSC played by smpp-ts) | binds, `submit_sm`, GSM7 / UCS2 / national tables, long messages, receipts, message id formats, MO, errors, throttling, network cuts: [jasmin/README.md](jasmin/README.md) | ✅ |
| [smscsim](https://github.com/ukarim/smscsim) | automated tests | Go | SMSC simulator (smpp-ts is the client) | `smsc.interop.ts`: bind, `enquire_link`, GSM7 / UCS2, long messages (`udh8`, `udh16`, `sar`), window, receipts | ✅ |
| [jsmpp](https://github.com/opentelecoms-org/jsmpp) 3.0.2 | interoperability | Java | SMSC (smpp-ts is the client) | same suite, against `servers/JsmppSmsc.java` | ✅ |
| [Cloudhopper SMPP](https://github.com/fizzed/cloudhopper-smpp) 5.0.9 | interoperability | Java (Netty 3) | SMSC (smpp-ts is the client) | same suite, against `servers/CloudhopperSmsc.java` | ✅ |
| [python-smpplib](https://github.com/python-smpplib/python-smpplib) 2.2.4 | interoperability | Python | client (smpp-ts is the server) | `server.interop.ts`: bind, short GSM7 and long UCS2 split by the peer, receipts, MO, unbind | ✅ |
| [gosmpp](https://github.com/linxGnu/gosmpp) 0.3.1 | interoperability | Go | client (smpp-ts is the server) | same scenario | ✅ |
| [php8-smpp](https://github.com/php8-smpp/php8-smpp) 0.1.1 (fork of onlinecity/php-smpp) | interoperability | PHP | client (smpp-ts is the server) | same scenario, `clients/php8-smpp/client.php` (see the note below) | ✅ |
| [Kannel](https://www.kannel.org/) 1.4.5 | real SMS gateway | C | client: `bearerbox` binds to smpp-ts, `smsbox` serves HTTP | `kannel/kannel.interop.ts`: bind, GSM7 via `sendsms`, long UCS2 (concatenated, reassembled), receipts to `dlr-url` matched to the message ids, MO to `get-url`, unbind on shutdown | ✅ |
| [@larvit/smpp](https://www.npmjs.com/package/@larvit/smpp) | comparative reference | TypeScript | — | feature comparison only ([docs/guides/comparison.md](../../docs/guides/comparison.md)); no test, to keep it out of the dependencies | — |

✅ = passes locally and in CI. The jsmpp and Cloudhopper jars are downloaded from Maven Central and checked against a SHA-256; Kannel and PHP come from the Ubuntu archive; php8-smpp is pinned by `clients/php8-smpp/composer.lock`.

**php8-smpp 0.1.1 cannot read delivery receipts.** Its parser assigns the receipt id (a string) to `DeliveryReceipt::$id`, typed `int`, under `strict_types`: every receipt throws `Cannot assign string to property … of type int`, whatever the id. The test client catches it, answers the `deliver_sm` itself and reads the id from the receipt text. The PDUs sent by smpp-ts are standard (the same receipts pass with every other peer).

**php8-smpp 0.1.1 can split a long message under several references.** With 8-bit UDH it takes the concatenation reference again for every segment (`getCsmsReference()` increments it) and writes only its second decimal digit (`substr((string)$ref, 1, 1)`): a message started at reference 47 sends its segments under 7, 8 and 9, and the receiving side, correctly, sees three different messages. The test client holds the reference constant while it sends one message.

SMPPSim (Selenium Software) is not in the matrix: its original site is gone and no mirror offers a download we can check.

## Kannel (smpp-ts server)

```sh
sudo apt-get install kannel          # Ubuntu / Debian: bearerbox and smsbox 1.4.5
npm run test:kannel                  # KANNEL_BIN=/usr/sbin by default on Debian systems
```

The test writes its own `kannel.conf` (free ports, `dlr-storage = internal`), starts `bearerbox` and `smsbox`, and serves `get-url` / `dlr-url` itself. Details: [kannel/README.md](kannel/README.md).

## Cloudhopper (smpp-ts client)

```sh
M=https://repo1.maven.org/maven2
curl -sSfLo ch-smpp.jar $M/com/fizzed/ch-smpp/5.0.9/ch-smpp-5.0.9.jar
curl -sSfLo ch-commons-util.jar $M/com/cloudhopper/ch-commons-util/6.0.2/ch-commons-util-6.0.2.jar
curl -sSfLo ch-commons-charset.jar $M/com/cloudhopper/ch-commons-charset/3.0.2/ch-commons-charset-3.0.2.jar
curl -sSfLo netty.jar $M/io/netty/netty/3.9.6.Final/netty-3.9.6.Final.jar
curl -sSfLo slf4j-api.jar $M/org/slf4j/slf4j-api/1.7.13/slf4j-api-1.7.13.jar
java -cp ch-smpp.jar:ch-commons-util.jar:ch-commons-charset.jar:netty.jar:slf4j-api.jar \
  test/interop/servers/CloudhopperSmsc.java 2775 &
SMPP_INTEROP_URL=smpp://127.0.0.1:2775 npm run test:interop
```

## php8-smpp (smpp-ts server)

```sh
composer install -d test/interop/clients/php8-smpp     # PHP 8.1+, ext-sockets, ext-mbstring
SMPP_INTEROP_CLIENT="php test/interop/clients/php8-smpp/client.php" npm run test:interop
```

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
