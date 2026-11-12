# Kannel compatibility suite

[Kannel](https://www.kannel.org/) is the open source SMS gateway many operators and aggregators still run. Its `bearerbox` is an SMPP **client**: here it binds to an smpp-ts `SmppServer`.

```
HTTP sendsms ──▶ smsbox ──▶ bearerbox ──SMPP──▶ smpp-ts SmppServer
                                       ◀──SMPP── deliver_sm (receipts, MO)
get-url / dlr-url ◀── smsbox ◀── bearerbox
```

## Run it

Needs `bearerbox` and `smsbox` (Ubuntu / Debian package `kannel`, version 1.4.5):

```sh
sudo apt-get install kannel
npm run test:kannel                      # KANNEL_BIN=/usr/sbin (Debian path) unless set
```

Without the package, in Docker:

```sh
docker build -t smppts-kannel - <<'DOCKERFILE'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends kannel
DOCKERFILE
docker run --rm -v "$PWD":/work -w /work -e KANNEL_BIN=/usr/sbin smppts-kannel npm run test:kannel
```

The test writes its own `kannel.conf` in a temporary directory (free ports, `dlr-storage = internal`), starts both boxes, serves `get-url` and `dlr-url` from the test process, and stops Kannel through its admin interface. On failure it prints the end of `bearerbox.log` and `smsbox.log`.

## What is checked

| Scenario | Path |
|---|---|
| Bind | `bearerbox` binds as transceiver with `smsc-username` / `smsc-password` |
| Short GSM7 message | `sendsms` → `submit_sm` (data_coding 0) → receipt from smpp-ts → `dlr-url` with `%d = 1` and `%F` = the message id smpp-ts returned |
| Long UCS2 message | `sendsms` with `coding=2` → concatenated `submit_sm` (8-bit UDH, data_coding 8) reassembled to the original text → receipts matched to the segment ids |
| MO | `deliver_sm` from smpp-ts → `get-url` with sender, recipient and text |
| Shutdown | `bearerbox` unbinds and the session closes cleanly |
