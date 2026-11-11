#!/usr/bin/env node
// Builds test/fixtures/deliver_sm.json: deliver_sm PDUs in the formats SMSCs are known to send.
//
//   node test/fixtures/build.mjs
//
// Bytes are assembled here by hand, following SMPP 3.4 §4.6.1 and §5.3: this script does NOT use the
// library's codec, so the fixtures check the decoder against the spec, not against our own encoder.
//
// These are reconstructions of documented formats (SMPP 3.4 Appendix B, Kannel, Jasmin, common SMSC
// variants), not captures. Anonymized real captures go in test/fixtures/captures/ (see README.md).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TLV = {
  receipted_message_id: 0x001e,
  sar_msg_ref_num: 0x020c,
  sar_total_segments: 0x020e,
  sar_segment_seqnum: 0x020f,
  network_error_code: 0x0423,
  message_payload: 0x0424,
  message_state: 0x0427,
};

const cstr = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const tlv = (tag, value) => Buffer.concat([u16(tag), u16(value.length), value]);

/** deliver_sm (command_id 0x00000005), SMPP 3.4 §4.6.1. */
function deliverSm({
  seq = 1,
  source = '2250700000000',
  dest = 'SENDER',
  sourceTon = 1,
  sourceNpi = 1,
  esmClass = 0,
  dataCoding = 0,
  shortMessage = Buffer.alloc(0),
  tlvs = [],
}) {
  const body = Buffer.concat([
    cstr(''), // service_type
    u8(sourceTon),
    u8(sourceNpi),
    cstr(source),
    u8(5), // dest_addr_ton: alphanumeric
    u8(0),
    cstr(dest),
    u8(esmClass),
    u8(0), // protocol_id
    u8(0), // priority_flag
    cstr(''), // schedule_delivery_time
    cstr(''), // validity_period
    u8(0), // registered_delivery
    u8(0), // replace_if_present_flag
    u8(dataCoding),
    u8(0), // sm_default_msg_id
    u8(shortMessage.length),
    shortMessage,
    ...tlvs,
  ]);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length, 0);
  header.writeUInt32BE(0x00000005, 4);
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(seq, 12);
  return Buffer.concat([header, body]).toString('hex');
}

const text = (s) => Buffer.from(s, 'latin1');
const ucs2 = (s) => Buffer.from(s, 'utf16le').swap16();
const udh8 = (ref, total, seq) => Buffer.from([5, 0x00, 3, ref, total, seq]);
const udh16 = (ref, total, seq) => Buffer.from([6, 0x08, 4, ref >> 8, ref & 0xff, total, seq]);

const DLR = 0x04;

const fixtures = [
  // ---------------------------------------------------------------- delivery receipts
  {
    name: 'appendix-b-delivered',
    origin: 'SMPP 3.4 Appendix B: reference receipt text',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:0123456789 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:Your code is 1',
        ),
      }),
    ],
    expect: {
      dlr: {
        messageId: '0123456789',
        status: 'DELIVERED',
        rawStatus: 'DELIVRD',
        errorCode: '000',
        submitted: 1,
        delivered: 1,
        doneDate: '2026-11-11T10:31:00.000Z',
        text: 'Your code is 1',
      },
    },
  },
  {
    name: 'capital-text-key',
    origin: 'Logica/CMG-derived SMSCs: "Text:" with a capital T',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:77001 sub:001 dlvrd:000 submit date:2611111030 done date:2611111045 stat:UNDELIV err:001 Text:Hello',
        ),
      }),
    ],
    expect: {
      dlr: { messageId: '77001', status: 'UNDELIVERABLE', errorCode: '001', delivered: 0, text: 'Hello' },
    },
  },
  {
    name: 'dates-with-seconds',
    origin: 'Common variant: YYMMDDhhmmss dates (12 digits)',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:abc123 sub:001 dlvrd:001 submit date:261111103015 done date:261111103142 stat:DELIVRD err:000 text:',
        ),
      }),
    ],
    expect: {
      dlr: {
        messageId: 'abc123',
        status: 'DELIVERED',
        submitDate: '2026-11-11T10:30:15.000Z',
        doneDate: '2026-11-11T10:31:42.000Z',
      },
    },
  },
  {
    name: 'hex-id-in-receipt',
    origin: 'SMSCs that return a decimal id in submit_sm_resp and the same id in hexadecimal in the receipt',
    messageIdFormat: 'hex-to-dec',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:1A2B3C4D sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:x',
        ),
      }),
    ],
    expect: { dlr: { messageId: '439041101', rawMessageId: '1A2B3C4D', status: 'DELIVERED' } },
  },
  {
    name: 'tlv-only',
    origin: 'SMPP 3.4 §5.3.2: receipted_message_id + message_state, empty short_message',
    pdus: [
      deliverSm({
        esmClass: DLR,
        tlvs: [
          tlv(TLV.receipted_message_id, cstr('MSG-42')),
          tlv(TLV.message_state, u8(2)), // DELIVERED
        ],
      }),
    ],
    expect: { dlr: { messageId: 'MSG-42', status: 'DELIVERED', rawStatus: '2' } },
  },
  {
    name: 'tlv-overrides-text',
    origin: 'SMSCs that send both: the TLVs take precedence over the text',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:WRONG sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:x',
        ),
        tlvs: [
          tlv(TLV.receipted_message_id, cstr('RIGHT')),
          tlv(TLV.message_state, u8(5)), // UNDELIVERABLE
          tlv(TLV.network_error_code, Buffer.from([0x03, 0x00, 0x0b])), // GSM, error 11
        ],
      }),
    ],
    expect: {
      dlr: { messageId: 'RIGHT', status: 'UNDELIVERABLE', networkError: { network_type: 3, error_code: 11 } },
    },
  },
  {
    name: 'expired',
    origin: 'Validity period over before delivery',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:900 sub:001 dlvrd:000 submit date:2611101030 done date:2611111030 stat:EXPIRED err:000 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '900', status: 'EXPIRED', delivered: 0 } },
  },
  {
    name: 'rejected',
    origin: 'Message refused by the SMSC after submit_sm_resp',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:901 sub:001 dlvrd:000 submit date:2611111030 done date:2611111030 stat:REJECTD err:069 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '901', status: 'REJECTED', errorCode: '069' } },
  },
  {
    name: 'intermediate-accepted',
    origin: 'Intermediate notification (esm_class 0x20), stat:ACCEPTD',
    pdus: [
      deliverSm({
        esmClass: 0x20,
        shortMessage: text(
          'id:902 sub:001 dlvrd:000 submit date:2611111030 done date:2611111030 stat:ACCEPTD err:000 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '902', status: 'ACCEPTED' } },
  },
  {
    name: 'enroute',
    origin: 'stat:ENROUTE, message still being delivered',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:903 sub:001 dlvrd:000 submit date:2611111030 done date:2611111030 stat:ENROUTE err:000 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '903', status: 'ENROUTE' } },
  },
  {
    name: 'lowercase-status',
    origin: 'SMSCs that send the status in lower case',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:904 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:delivrd err:000 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '904', status: 'DELIVERED' } },
  },
  {
    name: 'no-err-no-text',
    origin: 'Minimal receipts: neither err: nor text:',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:905 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD',
        ),
      }),
    ],
    expect: { dlr: { messageId: '905', status: 'DELIVERED', errorCode: undefined, text: undefined } },
  },
  {
    name: 'failed-alias',
    origin: 'Non-standard stat:FAILED',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:906 sub:001 dlvrd:000 submit date:2611111030 done date:2611111031 stat:FAILED err:034 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '906', status: 'UNDELIVERABLE', errorCode: '034' } },
  },
  {
    name: 'receipt-in-message-payload',
    origin: 'Receipt text in the message_payload TLV, sm_length 0',
    pdus: [
      deliverSm({
        esmClass: DLR,
        tlvs: [
          tlv(
            TLV.message_payload,
            text(
              'id:907 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:x',
            ),
          ),
        ],
      }),
    ],
    expect: { dlr: { messageId: '907', status: 'DELIVERED' } },
  },
  {
    name: 'jasmin-uuid-id',
    origin: 'Jasmin: UUID message ids',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:9d4c3a2e-6f1b-4c8e-a1d2-3b4c5d6e7f80 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:',
        ),
      }),
    ],
    expect: { dlr: { messageId: '9d4c3a2e-6f1b-4c8e-a1d2-3b4c5d6e7f80', status: 'DELIVERED' } },
  },
  {
    name: 'nested-id-in-text',
    origin: 'The original text contains "id:": only the leading key is the message id',
    pdus: [
      deliverSm({
        esmClass: DLR,
        shortMessage: text(
          'id:908 sub:001 dlvrd:001 submit date:2611111030 done date:2611111031 stat:DELIVRD err:000 text:my id:123 stat:x',
        ),
      }),
    ],
    expect: { dlr: { messageId: '908', status: 'DELIVERED' } },
  },

  // ---------------------------------------------------------------- incoming messages (MO)
  {
    name: 'mo-gsm7',
    origin: 'Plain MO, GSM 7-bit unpacked (data_coding 0)',
    pdus: [deliverSm({ dest: '1234', shortMessage: text('STOP') })],
    expect: { message: { text: 'STOP', parts: 1, from: '2250700000000', to: '1234' } },
  },
  {
    name: 'mo-ucs2-emoji',
    origin: 'MO in UCS2 with a surrogate pair',
    pdus: [deliverSm({ dest: '1234', dataCoding: 0x08, shortMessage: ucs2('Merci 🎉') })],
    expect: { message: { text: 'Merci 🎉', parts: 1 } },
  },
  {
    name: 'mo-udh8-out-of-order',
    origin: 'Long MO, 8-bit concatenation UDH, segments out of order',
    pdus: [
      deliverSm({
        dest: '1234',
        esmClass: 0x40,
        shortMessage: Buffer.concat([udh8(7, 2, 2), text(' world')]),
      }),
      deliverSm({
        dest: '1234',
        esmClass: 0x40,
        shortMessage: Buffer.concat([udh8(7, 2, 1), text('Hello')]),
      }),
    ],
    expect: { message: { text: 'Hello world', parts: 2 } },
  },
  {
    name: 'mo-udh16',
    origin: 'Long MO, 16-bit concatenation UDH (IEI 0x08)',
    pdus: [
      deliverSm({
        dest: '1234',
        esmClass: 0x40,
        shortMessage: Buffer.concat([udh16(0x1234, 2, 1), text('Bon')]),
      }),
      deliverSm({
        dest: '1234',
        esmClass: 0x40,
        shortMessage: Buffer.concat([udh16(0x1234, 2, 2), text('jour')]),
      }),
    ],
    expect: { message: { text: 'Bonjour', parts: 2 } },
  },
  {
    name: 'mo-kannel-udhi',
    origin: 'Kannel: UDH indicator sent as esm_class 0x43',
    pdus: [
      deliverSm({ dest: '1234', esmClass: 0x43, shortMessage: Buffer.concat([udh8(9, 2, 1), text('ab')]) }),
      deliverSm({ dest: '1234', esmClass: 0x43, shortMessage: Buffer.concat([udh8(9, 2, 2), text('cd')]) }),
    ],
    expect: { message: { text: 'abcd', parts: 2 } },
  },
  {
    name: 'mo-sar',
    origin: 'Long MO with SAR TLVs instead of a UDH',
    pdus: [
      deliverSm({
        dest: '1234',
        shortMessage: text('part one, '),
        tlvs: [
          tlv(TLV.sar_msg_ref_num, u16(300)),
          tlv(TLV.sar_total_segments, u8(2)),
          tlv(TLV.sar_segment_seqnum, u8(1)),
        ],
      }),
      deliverSm({
        dest: '1234',
        shortMessage: text('part two'),
        tlvs: [
          tlv(TLV.sar_msg_ref_num, u16(300)),
          tlv(TLV.sar_total_segments, u8(2)),
          tlv(TLV.sar_segment_seqnum, u8(2)),
        ],
      }),
    ],
    expect: { message: { text: 'part one, part two', parts: 2 } },
  },
  {
    name: 'mo-message-payload',
    origin: 'Long MO in a single PDU through message_payload',
    pdus: [deliverSm({ dest: '1234', tlvs: [tlv(TLV.message_payload, text('x'.repeat(300)))] })],
    expect: { message: { text: 'x'.repeat(300), parts: 1 } },
  },
  {
    name: 'mo-latin1',
    origin: 'MO in Latin-1 (data_coding 0x03)',
    pdus: [deliverSm({ dest: '1234', dataCoding: 0x03, shortMessage: text('Café à Abidjan') })],
    expect: { message: { text: 'Café à Abidjan', parts: 1 } },
  },
];

const out = join(dirname(fileURLToPath(import.meta.url)), 'deliver_sm.json');
writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`${fixtures.length} fixtures written to ${out}`);
