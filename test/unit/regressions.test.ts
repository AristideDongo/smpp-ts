/**
 * Regression tests for codec-only bugs (BUG-04, BUG-05, BUG-06).
 * Session bugs (BUG-01, 02, 03, 07, 08) are in test/integration/regressions.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { decodePdu, encodePdu } from '../../src/codec/pdu.js';
import { encodeGsm7 } from '../../src/encoding/gsm7.js';
import { encodeUcs2 } from '../../src/encoding/ucs2.js';
import { SmppDecodeError } from '../../src/errors.js';
import { COMMANDS } from '../../src/protocol/commands.js';
import { ESM_CLASS } from '../../src/protocol/constants.js';
import { COMMAND_STATUS } from '../../src/protocol/status.js';
import { buildUdh, decodeMessageContent, hasUdhIndicator } from '../../src/utils/multipart.js';

const concatUdh = buildUdh([{ iei: 0x00, data: Buffer.from([7, 2, 1]) }]);

describe('BUG-04: Kannel UDH indicator is honoured', () => {
  it('detects UDH with the Kannel indicator 0x43', () => {
    expect(hasUdhIndicator(ESM_CLASS.KANNEL_UDH_INDICATOR)).toBe(true);
    const content = decodeMessageContent({
      esm_class: ESM_CLASS.KANNEL_UDH_INDICATOR,
      data_coding: 0,
      short_message: Buffer.concat([concatUdh, encodeGsm7('hello')]),
    });
    expect(content.concat).toEqual({ reference: 7, total: 2, sequence: 1 });
    expect(content.text).toBe('hello');
  });

  it('does not treat messaging-mode bits as UDHI', () => {
    expect(hasUdhIndicator(ESM_CLASS.STORE_FORWARD)).toBe(false);
    const content = decodeMessageContent({
      esm_class: 0x03,
      data_coding: 0,
      short_message: encodeGsm7('hello'),
    });
    expect(content.udh).toBeUndefined();
    expect(content.text).toBe('hello');
  });
});

describe('BUG-05: UCS2 with UDH is not decoded as GSM', () => {
  it('decodes UCS2 after stripping the UDH', () => {
    const content = decodeMessageContent(
      {
        esm_class: ESM_CLASS.UDH_INDICATOR,
        data_coding: 0x08,
        short_message: Buffer.concat([concatUdh, encodeUcs2('Ça marche 🎉')]),
      },
      { packedGsm7: true },
    );
    expect(content.encoding).toBe('ucs2');
    expect(content.text).toBe('Ça marche 🎉');
  });
});

describe('BUG-06: bounded C-Octet String reads', () => {
  function bindRespWithBody(body: Buffer): Buffer {
    const buf = Buffer.concat([Buffer.alloc(16), body]);
    buf.writeUInt32BE(buf.length, 0);
    buf.writeUInt32BE(COMMANDS.bind_transceiver_resp.id, 4);
    buf.writeUInt32BE(1, 12);
    return buf;
  }

  it('stops at the end of the PDU (unterminated string)', () => {
    const buf = bindRespWithBody(Buffer.from('ABC', 'latin1'));
    expect(() => decodePdu(buf)).toThrowError(
      expect.objectContaining({ status: COMMAND_STATUS.ESME_RINVCMDLEN, name: 'SmppDecodeError' }),
    );
  });

  it('stops at the field maximum length (system_id: 16)', () => {
    const buf = bindRespWithBody(Buffer.from(`${'A'.repeat(16)}\0`, 'latin1'));
    expect(() => decodePdu(buf)).toThrowError(
      expect.objectContaining({ status: COMMAND_STATUS.ESME_RINVTLVLEN }),
    );
  });

  it('does not leak into the following fields', () => {
    // unterminated password (max 9): must not swallow system_type and what follows.
    const body = Buffer.concat([
      Buffer.from('id\0', 'latin1'),
      Buffer.from('123456789012', 'latin1'),
      Buffer.from('\0type\0', 'latin1'),
      Buffer.from([0x34, 0, 0, 0]),
    ]);
    const buf = Buffer.concat([Buffer.alloc(16), body]);
    buf.writeUInt32BE(buf.length, 0);
    buf.writeUInt32BE(COMMANDS.bind_transceiver.id, 4);
    expect(() => decodePdu(buf)).toThrow(SmppDecodeError);
  });

  it('accepts a field at exactly its maximum length', () => {
    const buf = encodePdu({
      command: 'bind_transceiver',
      system_id: 'A'.repeat(15),
      password: 'B'.repeat(8),
    });
    const pdu = decodePdu(buf);
    if (pdu.command !== 'bind_transceiver') throw new Error();
    expect(pdu.system_id).toHaveLength(15);
    expect(pdu.password).toHaveLength(8);
  });
});
