#!/usr/bin/env node
// Anonymizes a captured deliver_sm before it goes into test/fixtures/captures/.
//
//   npm run build
//   node test/fixtures/anonymize.mjs <hex of the PDU> [more PDUs…]
//
// Keeps what matters to the parser (formats, lengths, TLVs, UDH, data_coding, the shape of ids and
// dates) and replaces what identifies people: phone numbers, message text, message ids.
// Prints the anonymized hex. Check the result by eye before committing it.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { decodePdu, encodePdu } = await import(pathToFileURL(resolve('dist/index.js')).href);

/** Same length and character classes, different content: 0-9 → digits, a-f/A-F → hex, letters → letters. */
function scramble(value) {
  let out = '';
  for (const ch of value) {
    if (/[0-9]/.test(ch)) out += String(Math.floor(Math.random() * 10));
    else if (/[a-f]/.test(ch)) out += 'abcdef'[Math.floor(Math.random() * 6)];
    else if (/[A-F]/.test(ch)) out += 'ABCDEF'[Math.floor(Math.random() * 6)];
    else if (/[a-z]/.test(ch)) out += 'x';
    else if (/[A-Z]/.test(ch)) out += 'X';
    else out += ch;
  }
  return out;
}

/** A phone number keeps its country code and length; an alphanumeric sender becomes SENDER. */
function anonymizeAddress(addr) {
  if (!/^\+?\d+$/.test(addr)) return addr ? 'SENDER'.slice(0, Math.max(1, addr.length)) : addr;
  const keep = Math.min(3, addr.length - 4);
  return addr.slice(0, Math.max(0, keep)) + scramble(addr.slice(Math.max(0, keep)));
}

/** Receipt text: keeps every key and the format of each value, scrambles id and text. */
function anonymizeReceiptText(text) {
  return text
    .replace(/(\bid:)(\S+)/i, (_, k, v) => k + scramble(v))
    .replace(/(\btext:)(.*)$/is, (_, k, v) => k + 'x'.repeat(v.length));
}

/** Message content without its UDH: receipt text scrambled, MO text replaced by "x" (same length). */
function anonymizeBody(buf, isReceipt, dataCoding) {
  if (!buf || buf.length === 0) return buf;
  if (isReceipt) return Buffer.from(anonymizeReceiptText(buf.toString('latin1')), 'latin1');
  const out = Buffer.from(buf);
  const filler = dataCoding === 0x08 ? [0x00, 0x78] : [0x78];
  for (let i = 0; i < out.length; i++) out[i] = filler[i % filler.length];
  return out;
}

for (const hex of process.argv.slice(2)) {
  const pdu = decodePdu(Buffer.from(hex.replace(/\s+/g, ''), 'hex'));
  const isReceipt = (pdu.esm_class & 0x3c) !== 0 || pdu.receipted_message_id !== undefined;
  const hasUdh = (pdu.esm_class & 0x40) !== 0;
  const out = { ...pdu };
  out.source_addr = anonymizeAddress(pdu.source_addr ?? '');
  out.destination_addr = anonymizeAddress(pdu.destination_addr ?? '');
  for (const field of ['short_message', 'message_payload']) {
    const value = pdu[field];
    if (!Buffer.isBuffer(value) || value.length === 0) continue;
    const udh = hasUdh ? value.subarray(0, value[0] + 1) : Buffer.alloc(0);
    const body = anonymizeBody(value.subarray(udh.length), isReceipt, pdu.data_coding);
    out[field] = Buffer.concat([udh, body]);
  }
  if (out.receipted_message_id) out.receipted_message_id = scramble(out.receipted_message_id);
  console.log(encodePdu(out).toString('hex'));
}
