"""python-smpplib client for the smpp-ts server interop suite.

    python3 test/interop/clients/python_smpplib.py <host> <port>

Binds as transceiver, sends a short GSM7 message and a long UCS2 one (split by smpplib itself),
asks for receipts, waits for them and for one MO, unbinds, and prints a JSON summary on the last line.
"""

import json
import os
import re
import sys
import time

import smpplib.client
import smpplib.consts
import smpplib.gsm

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'expected.json'), encoding='utf-8') as f:
    EXPECTED = json.load(f)

host, port = sys.argv[1], int(sys.argv[2])
submitted, receipts, mos = [], [], []


def on_sent(pdu, **_):
    submitted.append(pdu.message_id.decode())


def on_received(pdu, **_):
    if pdu.esm_class & 0x04:  # delivery receipt
        rid = getattr(pdu, 'receipted_message_id', None)
        if rid:
            receipts.append(rid.decode() if isinstance(rid, bytes) else str(rid))
        else:
            m = re.search(rb'id:(\S+)', pdu.short_message)
            receipts.append(m.group(1).decode() if m else '?')
    else:
        data = pdu.short_message
        mos.append(data.decode('utf-16-be') if pdu.data_coding == 8 else data.decode('latin-1'))


client = smpplib.client.Client(host, port, timeout=2, allow_unknown_opt_params=True)
client.set_message_sent_handler(on_sent)
client.set_message_received_handler(on_received)
client.connect()
client.bind_transceiver(system_id=EXPECTED['systemId'], password=EXPECTED['password'])


def send(parts, encoding, esm_class):
    for part in parts:
        client.send_message(
            source_addr_ton=smpplib.consts.SMPP_TON_ALNUM,
            source_addr='PYTHON',
            dest_addr_ton=smpplib.consts.SMPP_TON_INTL,
            dest_addr_npi=smpplib.consts.SMPP_NPI_ISDN,
            destination_addr='2250700000000',
            short_message=part,
            data_coding=encoding,
            esm_class=esm_class,
            registered_delivery=1,
        )
        client.read_once()  # submit_sm_resp


send(*smpplib.gsm.make_parts(EXPECTED['short']))
send(*smpplib.gsm.make_parts(EXPECTED['long']))

deadline = time.time() + 15
while time.time() < deadline and (len(receipts) < len(submitted) or not mos):
    client.read_once()

client.unbind()
client.disconnect()
print(json.dumps({'submitted': submitted, 'receipts': receipts, 'mo': mos}))
