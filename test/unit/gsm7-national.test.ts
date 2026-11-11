import { describe, expect, it } from 'vitest';
import { LOCKING_SHIFT, SINGLE_SHIFT } from '../../src/encoding/gsm7-national.js';
import {
  NATIONAL_LANGUAGES,
  NATIONAL_LANGUAGE_ID,
  type NationalLanguage,
  SmppValidationError,
  buildParts,
  canEncodeGsm7,
  countSegments,
  decodeGsm7,
  decodeMessageContent,
  detectEncoding,
  encodeGsm7,
  hasLockingShift,
  parseUdh,
} from '../../src/index.js';

const LOCKING_LANGS = NATIONAL_LANGUAGES.filter(hasLockingShift);

describe('GSM7 national language tables (3GPP TS 23.038 annex A)', () => {
  it('has the 13 languages with their identifiers, 12 locking tables (none for Spanish)', () => {
    expect(NATIONAL_LANGUAGE_ID).toEqual({
      tr: 1,
      es: 2,
      pt: 3,
      bn: 4,
      gu: 5,
      hi: 6,
      kn: 7,
      ml: 8,
      or: 9,
      pa: 10,
      ta: 11,
      te: 12,
      ur: 13,
    });
    expect(LOCKING_LANGS).toHaveLength(12);
    expect(hasLockingShift('es')).toBe(false);
    expect(() => encodeGsm7('a', { locking: 'es' })).toThrow(SmppValidationError);
  });

  it('keeps 0-9 and a-z at their default positions in every locking table', () => {
    for (const lang of LOCKING_LANGS) {
      const t = LOCKING_SHIFT[lang]!;
      expect([...'0123456789'].map((_, i) => t[0x30 + i]).join(''), lang).toBe('0123456789');
      expect(Array.from({ length: 26 }, (_, i) => t[0x61 + i]).join(''), lang).toBe(
        'abcdefghijklmnopqrstuvwxyz',
      );
    }
  });

  it('every table entry is a single code point (precomposed nukta letters, as in 23.038)', () => {
    for (const lang of NATIONAL_LANGUAGES) {
      for (const table of [SINGLE_SHIFT[lang], LOCKING_SHIFT[lang] ?? {}]) {
        for (const ch of Object.values(table)) expect([...ch], `${lang} ${ch}`).toHaveLength(1);
      }
    }
    expect(Object.values(SINGLE_SHIFT.hi)).toContain('क़'); // क़
  });

  it('round-trips every character of every table, locking + single', () => {
    for (const lang of NATIONAL_LANGUAGES) {
      const tables = hasLockingShift(lang) ? { single: lang, locking: lang } : { single: lang };
      const chars = [
        ...Object.values(LOCKING_SHIFT[lang] ?? {}),
        ...Object.values(SINGLE_SHIFT[lang]),
      ].filter((c) => c !== '\r' && c !== '\f');
      const text = chars.join('');
      expect(canEncodeGsm7(text, tables), lang).toBe(true);
      expect(decodeGsm7(encodeGsm7(text, tables), tables), lang).toBe(text);
    }
  });

  it('a locking character costs 1 septet, a single shift character 2', () => {
    // Hindi: क is in the locking table, ॐ… in the single shift table only when absent from locking.
    const encoded = encodeGsm7('क', { locking: 'hi' });
    expect(encoded).toHaveLength(1);
    const singleOnly = Object.values(SINGLE_SHIFT.hi).find(
      (c) => !Object.values(LOCKING_SHIFT.hi!).includes(c),
    )!;
    expect(encodeGsm7(singleOnly, { single: 'hi', locking: 'hi' })).toHaveLength(2);
  });

  it('keeps the single shift behaviour of a plain language code (backward compatible)', () => {
    expect(encodeGsm7('ş', 'tr')).toEqual(Buffer.from([0x1b, 115]));
    expect(decodeGsm7(Buffer.from([0x1b, 115]), 'tr')).toBe('ş');
    expect(canEncodeGsm7('नमस्ते', 'hi')).toBe(false); // Devanagari letters need the locking table
  });
});

describe('detection and segments with national tables', () => {
  const hindi = 'नमस्ते, आपका कोड 123456 है।';

  it('picks GSM7 with the Hindi locking + single tables when allowed, UCS2 otherwise', () => {
    expect(detectEncoding(hindi)).toEqual({ encoding: 'ucs2' });
    expect(detectEncoding(hindi, { shiftTables: ['hi'] })).toEqual({
      encoding: 'gsm7',
      shift: 'hi',
      locking: 'hi',
    });
  });

  it('prefers the single shift table alone when it is enough (smaller UDH)', () => {
    expect(detectEncoding('Şule', { shiftTables: ['tr'] })).toEqual({ encoding: 'gsm7', shift: 'tr' });
  });

  it('counts 6 UDH octets for both tables: 152 septets instead of 70 UCS2 units', () => {
    const info = countSegments(hindi, { shiftTables: ['hi'] });
    expect(info).toMatchObject({
      encoding: 'gsm7',
      shift: 'hi',
      locking: 'hi',
      segments: 1,
      perSegment: 152,
    });
    expect(countSegments(hindi).perSegment).toBe(70);
    // Multipart: 6 + 5 (concat) = 11 UDH octets + UDHL → 146 septets per segment.
    const long = countSegments(hindi.repeat(8), { shiftTables: ['hi'] });
    expect(long.perSegment).toBe(146);
  });

  it('buildParts announces both tables in the UDH, and the receiver decodes the text back', () => {
    let checked = 0;
    for (const lang of LOCKING_LANGS) {
      // Characters only the locking table has: detection must pick it.
      const single = new Set(Object.values(SINGLE_SHIFT[lang]));
      const only = Object.values(LOCKING_SHIFT[lang]!).filter(
        (c) => !canEncodeGsm7(c) && !single.has(c) && c !== '\r',
      );
      if (only.length === 0) continue;
      checked++;
      const text = `${only.slice(0, 40).join('')} 42`.repeat(4);
      const built = buildParts(text, { reference: 9, shiftTables: [lang] });
      expect(built.locking, lang).toBe(lang);
      for (const part of built.parts) {
        const udh = parseUdh(part.short_message!)!;
        expect(udh.locking, lang).toBe(lang);
        expect(udh.shift, lang).toBe(lang);
      }
      const decoded = built.parts.map(
        (p) => decodeMessageContent({ ...p, short_message: p.short_message! }).text,
      );
      expect(decoded.join(''), lang).toBe(text);
    }
    expect(checked).toBeGreaterThanOrEqual(11);
  });

  it('a forced locking table is validated against the text', () => {
    expect(() =>
      buildParts('Привет', { reference: 1, encoding: 'gsm7', shift: 'hi', locking: 'hi' }),
    ).toThrow(SmppValidationError);
    const ok = buildParts('नमस्ते', { reference: 1, encoding: 'gsm7', shift: 'hi', locking: 'hi' });
    expect(ok.parts[0]!.short_message!.subarray(0, 7)).toEqual(Buffer.from([6, 0x24, 1, 6, 0x25, 1, 6]));
  });

  it('ignores a locking shift IE for a language without a locking table', () => {
    const udh = parseUdh(Buffer.from([3, 0x25, 1, NATIONAL_LANGUAGE_ID.es]))!;
    expect(udh.locking).toBeUndefined();
  });

  it('decodes an MO announcing the Tamil locking table', () => {
    const lang: NationalLanguage = 'ta';
    const text = Object.values(LOCKING_SHIFT[lang]!).slice(0, 10).join('');
    const body = encodeGsm7(text, { locking: lang });
    const sm = Buffer.concat([Buffer.from([3, 0x25, 1, NATIONAL_LANGUAGE_ID[lang]]), body]);
    expect(decodeMessageContent({ short_message: sm, esm_class: 0x40, data_coding: 0 }).text).toBe(text);
  });
});
