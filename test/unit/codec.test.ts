import { describe, expect, it } from 'vitest';
import { PduCodec, decodePdu, encodePdu, isCommand } from '../../src/codec/pdu.js';
import { SmppDecodeError, SmppValidationError } from '../../src/errors.js';
import { COMMANDS } from '../../src/protocol/commands.js';
import { COMMAND_STATUS } from '../../src/protocol/status.js';

describe('codec: encode / decode', () => {
  it('round-trips a submit_sm with TLVs', () => {
    const buf = encodePdu({
      command: 'submit_sm',
      sequence_number: 42,
      source_addr: 'MISSOU',
      source_addr_ton: 5,
      destination_addr: '2250700000000',
      dest_addr_ton: 1,
      dest_addr_npi: 1,
      registered_delivery: 1,
      short_message: Buffer.from('Hello'),
      user_message_reference: 7,
      network_error_code: { network_type: 3, error_code: 0x1234 },
    });
    expect(buf.readUInt32BE(0)).toBe(buf.length);
    expect(buf.readUInt32BE(4)).toBe(COMMANDS.submit_sm.id);
    const pdu = decodePdu(buf);
    expect(isCommand(pdu, 'submit_sm')).toBe(true);
    if (pdu.command !== 'submit_sm') throw new Error('unreachable');
    expect(pdu.sequence_number).toBe(42);
    expect(pdu.source_addr).toBe('MISSOU');
    expect(pdu.destination_addr).toBe('2250700000000');
    expect(pdu.sm_length).toBe(5);
    expect(pdu.short_message.toString()).toBe('Hello');
    expect(pdu.user_message_reference).toBe(7);
    expect(pdu.network_error_code).toEqual({ network_type: 3, error_code: 0x1234 });
  });

  it('encodes a string short_message according to data_coding', () => {
    const pdu = decodePdu(encodePdu({ command: 'submit_sm', data_coding: 8, short_message: 'é🎉' }));
    if (pdu.command !== 'submit_sm') throw new Error();
    expect(pdu.short_message.equals(Buffer.from([0x00, 0xe9, 0xd8, 0x3c, 0xdf, 0x89]))).toBe(true);
  });

  it('encodes empty-body commands as 16-octet PDUs', () => {
    for (const command of [
      'enquire_link',
      'enquire_link_resp',
      'unbind',
      'unbind_resp',
      'generic_nack',
    ] as const) {
      expect(encodePdu({ command, sequence_number: 1 }).length).toBe(16);
    }
  });

  it('round-trips submit_multi with SME and distribution list destinations', () => {
    const buf = encodePdu({
      command: 'submit_multi',
      dest_address: [
        { dest_flag: 1, dest_addr_ton: 1, dest_addr_npi: 1, destination_addr: '22501' },
        { dest_flag: 2, dl_name: 'friends' },
      ],
      short_message: Buffer.from('x'),
    });
    const pdu = decodePdu(buf);
    if (pdu.command !== 'submit_multi') throw new Error();
    expect(pdu.dest_address).toEqual([
      { dest_flag: 1, dest_addr_ton: 1, dest_addr_npi: 1, destination_addr: '22501' },
      { dest_flag: 2, dl_name: 'friends' },
    ]);
  });

  it('round-trips submit_multi_resp with unsuccess_sme', () => {
    const pdu = decodePdu(
      encodePdu({
        command: 'submit_multi_resp',
        message_id: 'abc',
        unsuccess_sme: [
          { dest_addr_ton: 1, dest_addr_npi: 1, destination_addr: '123', error_status_code: 0x0b },
        ],
      }),
    );
    if (pdu.command !== 'submit_multi_resp') throw new Error();
    expect(pdu.unsuccess_sme[0]?.error_status_code).toBe(0x0b);
  });

  it('decodes an error response with an empty body using defaults', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(16, 0);
    buf.writeUInt32BE(COMMANDS.bind_transceiver_resp.id, 4);
    buf.writeUInt32BE(COMMAND_STATUS.ESME_RBINDFAIL, 8);
    buf.writeUInt32BE(9, 12);
    const pdu = decodePdu(buf);
    if (pdu.command !== 'bind_transceiver_resp') throw new Error();
    expect(pdu.command_status).toBe(COMMAND_STATUS.ESME_RBINDFAIL);
    expect(pdu.system_id).toBe('');
  });

  it('keeps unknown TLVs and re-emits them', () => {
    const base = encodePdu({ command: 'deliver_sm_resp', message_id: '' });
    const tlv = Buffer.from([0x14, 0x00, 0x00, 0x02, 0xab, 0xcd]);
    const buf = Buffer.concat([base, tlv]);
    buf.writeUInt32BE(buf.length, 0);
    const pdu = decodePdu(buf);
    expect(pdu.unknown_tlvs).toEqual([{ tag: 0x1400, value: Buffer.from([0xab, 0xcd]) }]);
    expect(encodePdu({ ...pdu } as never).equals(buf)).toBe(true);
  });

  it('supports custom TLVs', () => {
    const codec = new PduCodec({
      customTlvs: [{ name: 'operator_ref', tag: 0x1501, type: 'cstring', max: 32 }],
    });
    const buf = codec.encode({ command: 'submit_sm', custom_tlvs: { operator_ref: 'XYZ' } });
    const pdu = codec.decode(buf);
    expect(pdu.custom_tlvs).toEqual({ operator_ref: 'XYZ' });
    // Avec le codec par défaut, le TLV est inconnu mais conservé.
    expect(decodePdu(buf).unknown_tlvs?.[0]?.tag).toBe(0x1501);
  });

  it('rejects custom TLVs colliding with standard tags', () => {
    expect(() => new PduCodec({ customTlvs: [{ name: 'x', tag: 0x0424, type: 'octets' }] })).toThrow(
      /Duplicate/,
    );
  });

  it('decodes multiple-instance TLVs as arrays', () => {
    const buf = encodePdu({
      command: 'broadcast_sm',
      broadcast_area_identifier: [Buffer.from([0, 1]), Buffer.from([0, 2])],
      broadcast_content_type: Buffer.from([0, 0, 1]),
    });
    const pdu = decodePdu(buf);
    if (pdu.command !== 'broadcast_sm') throw new Error();
    expect(pdu.broadcast_area_identifier).toHaveLength(2);
  });

  it('handles flag TLV alert_on_message_delivery', () => {
    const pdu = decodePdu(encodePdu({ command: 'submit_sm', alert_on_message_delivery: true }));
    expect(pdu).toMatchObject({ alert_on_message_delivery: true });
  });
});

describe('codec: validation before sending (SEC-03)', () => {
  it('rejects a C-Octet String longer than its max', () => {
    expect(() => encodePdu({ command: 'bind_transceiver', system_id: 'x'.repeat(16) })).toThrow(
      SmppValidationError,
    );
    expect(() => encodePdu({ command: 'bind_transceiver', password: '123456789' })).toThrow(/password/);
  });

  it('never puts the password value in validation messages', () => {
    try {
      encodePdu({ command: 'bind_transceiver', password: 'supersecret' });
      throw new Error('should throw');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('supersecret');
    }
  });

  it('rejects non-Latin-1 characters in C-Octet Strings', () => {
    expect(() => encodePdu({ command: 'submit_sm', source_addr: 'Ω' })).toThrow(SmppValidationError);
  });

  it('rejects sm_length inconsistent with short_message', () => {
    expect(() => encodePdu({ command: 'submit_sm', sm_length: 3, short_message: Buffer.from('ab') })).toThrow(
      /sm_length/,
    );
  });

  it('rejects short_message longer than 255 octets', () => {
    expect(() => encodePdu({ command: 'submit_sm', short_message: Buffer.alloc(256) })).toThrow(/too long/);
  });

  it('enforces short_message / message_payload exclusivity', () => {
    expect(() =>
      encodePdu({ command: 'submit_sm', short_message: Buffer.from('a'), message_payload: Buffer.from('b') }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects out-of-range integers', () => {
    expect(() => encodePdu({ command: 'submit_sm', esm_class: 256 })).toThrow(SmppValidationError);
    expect(() => encodePdu({ command: 'submit_sm', esm_class: -1 })).toThrow(SmppValidationError);
    expect(() => encodePdu({ command: 'submit_sm', sequence_number: 0x80000000 })).toThrow(
      SmppValidationError,
    );
  });

  it('rejects TLVs with invalid lengths', () => {
    expect(() => encodePdu({ command: 'submit_sm', source_subaddress: Buffer.from([1]) })).toThrow(
      /invalid length/,
    );
  });

  it('rejects PDUs larger than maxPduLength', () => {
    const codec = new PduCodec({ maxPduLength: 100 });
    expect(() => codec.encode({ command: 'submit_sm', message_payload: Buffer.alloc(200) })).toThrow(
      /too long/,
    );
  });

  it('rejects submit_multi without destinations', () => {
    expect(() => encodePdu({ command: 'submit_multi', dest_address: [] })).toThrow(/between 1 and 255/);
  });
});

describe('codec: decoding errors', () => {
  it('reports unknown command ids with ESME_RINVCMDID and the header', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(16, 0);
    buf.writeUInt32BE(0x00000999, 4);
    buf.writeUInt32BE(77, 12);
    try {
      decodePdu(buf);
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SmppDecodeError);
      expect((err as SmppDecodeError).status).toBe(COMMAND_STATUS.ESME_RINVCMDID);
      expect((err as SmppDecodeError).header?.sequence_number).toBe(77);
    }
  });

  it('rejects a TLV whose length exceeds the remaining PDU', () => {
    const base = encodePdu({ command: 'submit_sm' });
    const buf = Buffer.concat([base, Buffer.from([0x02, 0x04, 0x00, 0x10, 0x01])]);
    buf.writeUInt32BE(buf.length, 0);
    expect(() => decodePdu(buf)).toThrow(/exceeds the remaining/);
  });

  it('rejects a truncated TLV header', () => {
    const base = encodePdu({ command: 'submit_sm' });
    const buf = Buffer.concat([base, Buffer.from([0x02, 0x04])]);
    buf.writeUInt32BE(buf.length, 0);
    expect(() => decodePdu(buf)).toThrowError(
      expect.objectContaining({ status: COMMAND_STATUS.ESME_RINVTLVSTREAM }),
    );
  });

  it('rejects a command_length that does not match the buffer', () => {
    const buf = encodePdu({ command: 'enquire_link' });
    buf.writeUInt32BE(20, 0);
    expect(() => decodePdu(buf)).toThrow(/command_length/);
  });

  it('non-strict mode tolerates over-long strings within the PDU', () => {
    const body = Buffer.from(`${'x'.repeat(20)}\0`, 'latin1');
    const buf = Buffer.concat([Buffer.alloc(16), body]);
    buf.writeUInt32BE(buf.length, 0);
    buf.writeUInt32BE(COMMANDS.bind_transceiver_resp.id, 4);
    expect(() => decodePdu(buf)).toThrow(SmppDecodeError);
    const lenient = new PduCodec({ strict: false }).decode(buf);
    if (lenient.command !== 'bind_transceiver_resp') throw new Error();
    expect(lenient.system_id).toBe('x'.repeat(20));
  });
});

describe('codec: TLV edge cases', () => {
  const withTlv = (tlv: Buffer) => {
    const base = encodePdu({ command: 'deliver_sm_resp', message_id: '' });
    const buf = Buffer.concat([base, tlv]);
    buf.writeUInt32BE(buf.length, 0);
    return buf;
  };

  it('strict mode rejects integer TLVs of the wrong size, lenient mode reads them', () => {
    // message_state (uint8) transmis sur 2 octets
    const buf = withTlv(Buffer.from([0x04, 0x27, 0x00, 0x02, 0x00, 0x02]));
    expect(() => decodePdu(buf)).toThrow(/expected 1 octets/);
    expect(new PduCodec({ strict: false }).decode(buf)).toMatchObject({ message_state: 2 });
  });

  it('reads cstring TLVs with or without NULL terminator', () => {
    expect(decodePdu(withTlv(Buffer.from([0x00, 0x1e, 0x00, 0x03, 0x41, 0x42, 0x00])))).toMatchObject({
      receipted_message_id: 'AB',
    });
    expect(decodePdu(withTlv(Buffer.from([0x00, 0x1e, 0x00, 0x02, 0x41, 0x42])))).toMatchObject({
      receipted_message_id: 'AB',
    });
  });

  it('rejects malformed network_error_code and flag TLVs', () => {
    expect(() => decodePdu(withTlv(Buffer.from([0x04, 0x23, 0x00, 0x02, 0x01, 0x02])))).toThrow(
      /expected 3 octets/,
    );
    expect(() => decodePdu(withTlv(Buffer.from([0x13, 0x0c, 0x00, 0x02, 0x01, 0x02])))).toThrow(/0 or 1/);
    expect(decodePdu(withTlv(Buffer.from([0x13, 0x0c, 0x00, 0x01, 0x05])))).toMatchObject({
      alert_on_message_delivery: 5,
    });
  });

  it('rejects octet TLVs outside their bounds in strict mode only', () => {
    const buf = withTlv(Buffer.from([0x02, 0x02, 0x00, 0x01, 0x01])); // source_subaddress min 2
    expect(() => decodePdu(buf)).toThrow(/invalid length/);
    expect(new PduCodec({ strict: false }).decode(buf)).toMatchObject({
      source_subaddress: Buffer.from([1]),
    });
  });

  it('rejects an invalid dest_flag on decode and encode', () => {
    const good = encodePdu({ command: 'submit_multi', dest_address: [{ dest_flag: 2, dl_name: 'x' }] });
    const idx = good.indexOf(2, 16 + 1 + 1 + 1 + 1 + 1); // number_of_dests puis dest_flag
    const bad = Buffer.from(good);
    bad[idx] = 9;
    expect(() => decodePdu(bad)).toThrow(/dest_flag/);
    expect(() => encodePdu({ command: 'submit_multi', dest_address: [{ dest_flag: 3 } as never] })).toThrow(
      /dest_flag/,
    );
  });

  it('validates TLV value types on encode', () => {
    expect(() => encodePdu({ command: 'submit_sm', receipted_message_id: 5 as never })).toThrow(
      /must be a string/,
    );
    expect(() => encodePdu({ command: 'submit_sm', message_payload: 'x' as never })).toThrow(/Buffer/);
    expect(() => encodePdu({ command: 'submit_sm', network_error_code: 1 as never })).toThrow(/network_type/);
    expect(() => encodePdu({ command: 'submit_sm', receipted_message_id: 'x'.repeat(65) })).toThrow(
      /too long/,
    );
    expect(() => encodePdu({ command: 'submit_sm', custom_tlvs: { nope: 1 } })).toThrow(/Unknown custom TLV/);
    expect(() => encodePdu({ command: 'nope' as never })).toThrow(/Unknown command/);
    expect(() => encodePdu({ command: 'submit_sm', short_message: 42 as never })).toThrow(
      /short_message must be/,
    );
  });

  it('rejects a PDU buffer shorter than its header', () => {
    expect(() => decodePdu(Buffer.alloc(8))).toThrow(/shorter than its header/);
  });
});
