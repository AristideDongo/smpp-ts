import { describe, expect, it } from 'vitest';
import { decodeGsm7 } from '../../src/encoding/gsm7.js';
import { decodeUcs2 } from '../../src/encoding/ucs2.js';
import { Reassembler, buildParts, decodeMessageContent, parseUdh } from '../../src/utils/multipart.js';
import { countSegments, segmentCapacity, splitText, udhLength } from '../../src/utils/segments.js';

describe('countSegments (§9 capacities)', () => {
  it.each([
    ['gsm7', 'a', 160, 153],
    ['latin1', 'é', 140, 134],
    ['ucs2', 'Ω', 70, 67],
  ])('%s: single %s, multipart %s', (encoding, ch, single, multi) => {
    expect(countSegments(ch.repeat(single), { encoding }).segments).toBe(1);
    expect(countSegments(ch.repeat(single + 1), { encoding }).segments).toBe(2);
    expect(countSegments(ch.repeat(multi * 2), { encoding }).segments).toBe(2);
    expect(countSegments(ch.repeat(multi * 2 + 1), { encoding }).segments).toBe(3);
  });

  it('counts extension characters as 2 septets', () => {
    expect(countSegments('€'.repeat(80)).segments).toBe(1);
    expect(countSegments('€'.repeat(81)).segments).toBe(2);
    const info = countSegments('a'.repeat(150));
    expect(info).toMatchObject({ encoding: 'gsm7', units: 150, perSegment: 160, remaining: 10 });
  });

  it('reports UCS2 for emoji, counting surrogate pairs as 2 units', () => {
    const info = countSegments('🎉'.repeat(35));
    expect(info).toMatchObject({ encoding: 'ucs2', units: 70, segments: 1 });
  });

  it('throws when the forced encoding cannot represent the text', () => {
    expect(() => countSegments('🎉', { encoding: 'gsm7' })).toThrow(/cannot be represented/);
    expect(() => countSegments('🎉', { encoding: 'latin1' })).toThrow(/cannot be represented/);
  });

  it('accounts for UDH sizes', () => {
    expect(udhLength(true, 'udh8')).toBe(6);
    expect(udhLength(true, 'udh16')).toBe(7);
    expect(udhLength(true, 'sar')).toBe(0);
    expect(udhLength(false, 'udh8', 'tr')).toBe(4);
    expect(udhLength(true, 'udh8', 'tr')).toBe(9);
    expect(segmentCapacity(7, 7)).toBe(152);
    expect(segmentCapacity(7, 9)).toBe(149);
    expect(countSegments('a'.repeat(160), { strategy: 'sar' }).segments).toBe(1);
    expect(countSegments('a'.repeat(320), { strategy: 'sar' }).segments).toBe(2);
  });
});

describe('splitText', () => {
  it('never splits a GSM escape sequence', () => {
    const text = `${'a'.repeat(152)}€${'t'.repeat(20)}`;
    const { parts } = splitText(text);
    expect(parts[0]).toBe('a'.repeat(152));
    expect(parts[1]?.startsWith('€')).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(66)}🎉${'b'.repeat(10)}`;
    const { parts } = splitText(text);
    expect(parts[0]).toBe('a'.repeat(66));
    expect(parts[1]?.startsWith('🎉')).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('payload strategy keeps a single part', () => {
    expect(splitText('x'.repeat(500), { strategy: 'payload' }).parts).toHaveLength(1);
  });

  it('refuses more than 255 segments', () => {
    expect(() => splitText('x'.repeat(153 * 256))).toThrow(/max 255/);
  });
});

describe('buildParts', () => {
  it('builds UDH 8-bit concatenated parts', () => {
    const built = buildParts('a'.repeat(200), { reference: 0x1ab });
    expect(built.parts).toHaveLength(2);
    const p1 = built.parts[0]!;
    expect(p1.esm_class & 0x40).toBe(0x40);
    const udh = parseUdh(p1.short_message!);
    expect(udh?.concat).toEqual({ reference: 0xab, total: 2, sequence: 1 });
    expect(decodeGsm7(p1.short_message!.subarray(6))).toBe('a'.repeat(153));
  });

  it('builds UDH 16-bit parts', () => {
    const built = buildParts('a'.repeat(200), { reference: 0x1ab, strategy: 'udh16' });
    expect(parseUdh(built.parts[1]!.short_message!)?.concat).toEqual({
      reference: 0x1ab,
      total: 2,
      sequence: 2,
    });
  });

  it('builds SAR parts', () => {
    const built = buildParts('🎉'.repeat(40), { reference: 9, strategy: 'sar' });
    expect(built.parts).toHaveLength(2);
    expect(built.parts[1]).toMatchObject({
      sar_msg_ref_num: 9,
      sar_total_segments: 2,
      sar_segment_seqnum: 2,
      esm_class: 0,
    });
    expect(decodeUcs2(Buffer.concat(built.parts.map((p) => p.short_message!)))).toBe('🎉'.repeat(40));
  });

  it('builds a single message_payload part', () => {
    const built = buildParts('x'.repeat(400), { reference: 1, strategy: 'payload' });
    expect(built.parts).toHaveLength(1);
    expect(built.parts[0]?.message_payload?.length).toBe(400);
    expect(built.parts[0]?.short_message).toBeUndefined();
  });

  it('adds the national shift IE', () => {
    const built = buildParts('Şişli', { reference: 1, shiftTables: ['tr'] });
    const udh = parseUdh(built.parts[0]!.short_message!);
    expect(udh?.shift).toBe('tr');
    const content = decodeMessageContent({
      esm_class: built.parts[0]!.esm_class,
      data_coding: 0,
      short_message: built.parts[0]!.short_message!,
    });
    expect(content.text).toBe('Şişli');
  });

  it('packs GSM7 with fill bits after the UDH', () => {
    const built = buildParts('a'.repeat(200), { reference: 5, packGsm7: true });
    const p = built.parts[0]!;
    const content = decodeMessageContent(
      { esm_class: p.esm_class, data_coding: 0, short_message: p.short_message! },
      { packedGsm7: true },
    );
    expect(content.text).toBe('a'.repeat(153));
  });
});

describe('Reassembler', () => {
  const seg = (sequence: number, body: string, reference = 1, total = 3) => ({
    source: 'A',
    destination: 'B',
    concat: { reference, total, sequence },
    body: Buffer.from(body),
    dataCoding: 0x03,
    meta: sequence,
  });

  it('reassembles out-of-order segments', () => {
    const r = new Reassembler();
    expect(r.add(seg(2, 'b'))).toBeUndefined();
    expect(r.add(seg(3, 'c'))).toBeUndefined();
    const done = r.add(seg(1, 'a'));
    expect(done?.text).toBe('abc');
    expect(done?.segments.map((s) => s.meta)).toEqual([1, 2, 3]);
    expect(r.size).toBe(0);
  });

  it('emits a partial message when the TTL expires', async () => {
    const partials: string[] = [];
    const r = new Reassembler({
      ttl: 30,
      onPartial: (m) => partials.push(`${m.text}|${m.missing.join(',')}`),
    });
    r.add(seg(1, 'a'));
    r.add(seg(3, 'c'));
    await new Promise((res) => setTimeout(res, 80));
    expect(partials).toEqual(['ac|2']);
    expect(r.size).toBe(0);
  });

  it('bounds the number of buffers (SEC-04)', () => {
    const evicted: number[] = [];
    const r = new Reassembler({ maxBuffers: 2, onPartial: (m) => evicted.push(m.reference) });
    r.add(seg(1, 'a', 1));
    r.add(seg(1, 'a', 2));
    r.add(seg(1, 'a', 3));
    expect(r.size).toBe(2);
    expect(evicted).toEqual([1]);
    r.clear();
  });

  it('ignores invalid sequence numbers', () => {
    const r = new Reassembler();
    expect(r.add(seg(0, 'x'))).toBeUndefined();
    expect(r.add(seg(4, 'x'))).toBeUndefined();
    expect(r.size).toBe(0);
  });
});
