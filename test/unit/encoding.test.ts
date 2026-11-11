import { describe, expect, it } from 'vitest';
import { detectEncoding } from '../../src/encoding/detect.js';
import {
  GSM7_BASIC_TABLE,
  canEncodeGsm7,
  decodeGsm7,
  encodeGsm7,
  gsm7Length,
  packSeptets,
  unpackSeptets,
} from '../../src/encoding/gsm7.js';
import {
  canEncodeLatin1,
  decodeAscii,
  decodeLatin1,
  encodeAscii,
  encodeLatin1,
} from '../../src/encoding/latin1.js';
import { EncodingRegistry, decodeText, encodeText, encodings } from '../../src/encoding/registry.js';
import { decodeUcs2, encodeUcs2 } from '../../src/encoding/ucs2.js';
import { SmppValidationError } from '../../src/errors.js';

describe('GSM 03.38', () => {
  it('basic table has 128 entries', () => {
    expect(GSM7_BASIC_TABLE.length).toBe(128);
    expect(GSM7_BASIC_TABLE[0]).toBe('@');
    expect(GSM7_BASIC_TABLE[0x7f]).toBe('à');
  });

  it('round-trips the whole basic table and extension characters', () => {
    const basic = [...GSM7_BASIC_TABLE].filter((_, i) => i !== 0x1b).join('');
    const text = `${basic}€[]{}\\^~|`;
    expect(decodeGsm7(encodeGsm7(text))).toBe(text);
  });

  it('counts extension characters as 2 septets', () => {
    expect(gsm7Length('a€')).toBe(3);
    expect(encodeGsm7('€')).toEqual(Buffer.from([0x1b, 0x65]));
  });

  it('throws instead of replacing unrepresentable characters', () => {
    expect(() => encodeGsm7('ê')).toThrow(SmppValidationError);
    expect(canEncodeGsm7('ê')).toBe(false);
  });

  it('supports national single shift tables', () => {
    expect(canEncodeGsm7('ş', 'tr')).toBe(true);
    expect(decodeGsm7(encodeGsm7('Şişli ğ', 'tr'), 'tr')).toBe('Şişli ğ');
    expect(decodeGsm7(encodeGsm7('Ácá', 'es'), 'es')).toBe('Ácá');
    expect(decodeGsm7(encodeGsm7('ação', 'pt'), 'pt')).toBe('ação');
  });

  it('decodes unknown escape codes as the basic character and invalid septets as U+FFFD', () => {
    expect(decodeGsm7(Buffer.from([0x1b, 0x41]))).toBe('A');
    expect(decodeGsm7(Buffer.from([0x80]))).toBe('�');
    expect(decodeGsm7(Buffer.from([0x41, 0x1b]))).toBe('A');
  });

  it('packs and unpacks septets', () => {
    const septets = encodeGsm7('hellohello');
    const packed = packSeptets(septets);
    expect(packed.toString('hex')).toBe('e8329bfd4697d9ec37');
    expect(unpackSeptets(packed, septets.length).equals(septets)).toBe(true);
  });

  it('packs with fill bits', () => {
    const septets = encodeGsm7('Test');
    for (let fill = 0; fill < 7; fill++) {
      expect(unpackSeptets(packSeptets(septets, fill), septets.length, fill).equals(septets)).toBe(true);
    }
  });
});

describe('Latin-1, ASCII, UCS2', () => {
  it('Latin-1 round-trip and strictness', () => {
    expect(decodeLatin1(encodeLatin1('çàêÿ'))).toBe('çàêÿ');
    expect(canEncodeLatin1('€')).toBe(false);
    expect(() => encodeLatin1('€')).toThrow(SmppValidationError);
  });

  it('ASCII strictness', () => {
    expect(() => encodeAscii('é')).toThrow(SmppValidationError);
    expect(decodeAscii(Buffer.from([0x41, 0xff]))).toBe('A�');
  });

  it('UCS2 is UTF-16BE and keeps surrogate pairs', () => {
    expect(encodeUcs2('A')).toEqual(Buffer.from([0x00, 0x41]));
    expect(decodeUcs2(encodeUcs2('Code 🎉 ok'))).toBe('Code 🎉 ok');
    expect(decodeUcs2(Buffer.from([0x00, 0x41, 0x00]))).toBe('A');
  });
});

describe('registry', () => {
  it('maps data_coding values', () => {
    expect(encodings.forDataCoding(0x00)?.name).toBe('gsm7');
    expect(encodings.forDataCoding(0x01)?.name).toBe('gsm7');
    expect(encodings.forDataCoding(0x03)?.name).toBe('latin1');
    expect(encodings.forDataCoding(0x08)?.name).toBe('ucs2');
    expect(encodings.forDataCoding(0x04)).toBeUndefined();
    expect(encodings.forDataCoding(0xf0)?.name).toBe('gsm7');
    expect(encodings.forDataCoding(0xf4)).toBeUndefined();
    expect(encodings.forDataCoding(0x18)?.name).toBe('ucs2');
  });

  it('is extensible', () => {
    const reg = new EncodingRegistry();
    reg.register(
      {
        name: 'upper',
        dataCoding: 0xc0 & 0,
        unitBits: 8,
        canEncode: () => true,
        encode: (t) => Buffer.from(t.toUpperCase(), 'latin1'),
        decode: (b) => Buffer.from(b).toString('latin1'),
        length: (t) => t.length,
      },
      { mapDataCoding: false },
    );
    reg.mapDataCoding(0x00, 'upper');
    expect(encodeText('abc', 0, reg).toString()).toBe('ABC');
    expect(() => reg.mapDataCoding(0, 'nope')).toThrow();
    expect(() => reg.get('nope')).toThrow();
  });

  it('refuses to encode text with a binary data_coding', () => {
    expect(() => encodeText('abc', 0x04)).toThrow(/binary/);
    expect(decodeText(Buffer.from('abc'), 0x04)).toBeUndefined();
  });
});

describe('detectEncoding', () => {
  it('prefers GSM7', () => {
    expect(detectEncoding('Hello {world} €')).toEqual({ encoding: 'gsm7' });
  });
  it('uses a shift table only when allowed', () => {
    expect(detectEncoding('Şişli')).toEqual({ encoding: 'ucs2' });
    expect(detectEncoding('Şişli', { shiftTables: ['tr'] })).toEqual({ encoding: 'gsm7', shift: 'tr' });
  });
  it('uses Latin-1 only when allowed', () => {
    expect(detectEncoding('Fenêtre')).toEqual({ encoding: 'ucs2' });
    expect(detectEncoding('Fenêtre', { allowLatin1: true })).toEqual({ encoding: 'latin1' });
  });
  it('falls back to UCS2 for emoji', () => {
    expect(detectEncoding('Votre code est 123456 🎉', { allowLatin1: true })).toEqual({ encoding: 'ucs2' });
  });
});

describe('registered codecs expose a consistent interface', () => {
  it.each([
    ['gsm7', 'Hello €', 8],
    ['latin1', 'Fenêtre', 7],
    ['ucs2', 'Ça 🎉', 5],
    ['ascii', 'Hello', 5],
  ])('%s', (name, text, length) => {
    const codec = encodings.get(name);
    expect(encodings.has(name)).toBe(true);
    expect(codec.canEncode(text)).toBe(true);
    expect(codec.decode(codec.encode(text))).toBe(text);
    expect(codec.length(text)).toBe(length);
  });

  it('rejects text outside the alphabet', () => {
    expect(encodings.get('gsm7').canEncode('ê')).toBe(false);
    expect(encodings.get('ascii').canEncode('é')).toBe(false);
    expect(encodings.get('latin1').canEncode('€')).toBe(false);
  });
});
