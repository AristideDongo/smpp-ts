import { describe, expect, it } from 'vitest';
import { SmppValidationError } from '../../src/errors.js';
import { ESM_CLASS } from '../../src/protocol/constants.js';
import { buildBinaryParts, parseUdh } from '../../src/utils/multipart.js';

/** Content and UDH of a segment built by buildBinaryParts. */
function segment(part: { short_message?: Buffer; message_payload?: Buffer }) {
  const buf = (part.short_message ?? part.message_payload)!;
  const udh = parseUdh(buf);
  return { udh, body: buf.subarray(udh?.length ?? 0), raw: buf };
}

describe('buildBinaryParts', () => {
  it('sends short content in a single PDU, with no UDH', () => {
    const built = buildBinaryParts(Buffer.alloc(100, 0xaa), { reference: 7 });
    expect(built.parts).toHaveLength(1);
    expect(built.dataCoding).toBe(0x04);
    expect(built.udhLength).toBe(0);
    expect(built.parts[0]!.esm_class).toBe(0);
    expect(built.parts[0]!.short_message).toHaveLength(100);
  });

  it('adds 8-bit application ports and keeps 133 octets of content', () => {
    const built = buildBinaryParts(Buffer.alloc(133, 1), { reference: 1, sourcePort: 9200, destPort: 2948 });
    // Ports over 255 force the 16-bit form: UDHL + IEI + len + 4 = 7 octets of UDH.
    expect(built.udhLength).toBe(7);
    expect(built.parts).toHaveLength(1);
    const { udh, body } = segment(built.parts[0]!);
    expect(udh?.ports).toEqual({ source: 9200, destination: 2948, bits: 16 });
    expect(body).toHaveLength(133);
    expect(built.parts[0]!.esm_class! & ESM_CLASS.UDH_INDICATOR).toBeTruthy();
  });

  it('uses the 8-bit port form when both ports fit in a byte', () => {
    const built = buildBinaryParts(Buffer.alloc(10), { reference: 1, sourcePort: 200, destPort: 100 });
    const { udh } = segment(built.parts[0]!);
    expect(udh?.ports).toEqual({ source: 200, destination: 100, bits: 8 });
    expect(built.udhLength).toBe(5);
  });

  it('splits long content, numbering the segments and keeping every octet', () => {
    const data = Buffer.alloc(400, 0);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const built = buildBinaryParts(data, { reference: 0x1234, destPort: 2948 });
    // UDH = UDHL + concat(5) + ports 16-bit (6) = 12, leaving 128 octets per segment.
    expect(built.udhLength).toBe(12);
    expect(built.parts).toHaveLength(Math.ceil(400 / 128));
    const bodies: Buffer[] = [];
    built.parts.forEach((part, idx) => {
      const { udh, body } = segment(part);
      expect(udh?.concat).toEqual({ reference: 0x34, total: built.parts.length, sequence: idx + 1 });
      expect(udh?.ports?.destination).toBe(2948);
      bodies.push(body);
    });
    expect(Buffer.concat(bodies).equals(data)).toBe(true);
  });

  it('udh16 carries the full 16-bit reference', () => {
    const built = buildBinaryParts(Buffer.alloc(300), { reference: 0xbeef, strategy: 'udh16' });
    const { udh } = segment(built.parts[0]!);
    expect(udh?.concat?.reference).toBe(0xbeef);
    expect(built.udhLength).toBe(7);
  });

  it('sar puts the concatenation in TLVs, with no UDH', () => {
    const built = buildBinaryParts(Buffer.alloc(300), { reference: 42, strategy: 'sar' });
    expect(built.udhLength).toBe(0);
    expect(built.parts[0]).toMatchObject({
      sar_msg_ref_num: 42,
      sar_total_segments: 3,
      sar_segment_seqnum: 1,
      esm_class: 0,
    });
    expect(built.parts[0]!.short_message).toHaveLength(140);
  });

  it('payload sends everything in message_payload, unsplit', () => {
    const built = buildBinaryParts(Buffer.alloc(5000, 9), { reference: 1, strategy: 'payload' });
    expect(built.parts).toHaveLength(1);
    expect(built.parts[0]!.message_payload).toHaveLength(5000);
    expect(built.parts[0]!.short_message).toBeUndefined();
  });

  it('refuses an impossible port and content over 255 segments', () => {
    expect(() => buildBinaryParts(Buffer.alloc(1), { reference: 1, destPort: 70_000 })).toThrow(
      SmppValidationError,
    );
    expect(() => buildBinaryParts(Buffer.alloc(1), { reference: 1, destPort: 300, portBits: 8 })).toThrow(
      /8-bit ports/,
    );
    expect(() => buildBinaryParts(Buffer.alloc(40_000), { reference: 1 })).toThrow(/max 255/);
  });
});
