import { SmppValidationError } from '../errors.js';

/**
 * GSM 03.38 / 3GPP TS 23.038 alphabet.
 * Septets are handled unpacked (one septet per byte), the usual form in SMPP.
 * `packSeptets` / `unpackSeptets` pack them when the SMSC requires it.
 */

const ESC = 0x1b;

// biome-ignore format: table aligned on 16 columns
const BASIC_TABLE =
  '@£$¥èéùìòÇ\nØø\rÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ' +
  ' !"#¤%&\'()*+,-./' +
  '0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNO' +
  'PQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmno' +
  'pqrstuvwxyzäöñüà';

/** Default extension table (after ESC). */
const DEFAULT_EXTENSION: Record<number, string> = {
  10: '\f',
  20: '^',
  40: '{',
  41: '}',
  47: '\\',
  60: '[',
  61: '~',
  62: ']',
  64: '|',
  101: '€',
};

/** Languages that have a national single shift table. */
export type NationalLanguage = 'tr' | 'es' | 'pt';

/** Language identifiers (3GPP TS 23.038 §6.2.1.2.4), value of UDH IE 0x24. */
export const NATIONAL_LANGUAGE_ID: Record<NationalLanguage, number> = { tr: 0x01, es: 0x02, pt: 0x03 };

/** National single shift tables (3GPP TS 23.038 annex A.2). */
const SINGLE_SHIFT_TABLES: Record<NationalLanguage, Record<number, string>> = {
  tr: {
    ...DEFAULT_EXTENSION,
    71: 'Ğ',
    73: 'İ',
    83: 'Ş',
    99: 'ç',
    103: 'ğ',
    105: 'ı',
    115: 'ş',
  },
  es: {
    ...DEFAULT_EXTENSION,
    9: 'ç',
    65: 'Á',
    73: 'Í',
    79: 'Ó',
    85: 'Ú',
    97: 'á',
    105: 'í',
    111: 'ó',
    117: 'ú',
  },
  pt: {
    ...DEFAULT_EXTENSION,
    5: 'ê',
    9: 'ç',
    11: 'Ô',
    12: 'ô',
    14: 'Á',
    15: 'á',
    18: 'Φ',
    19: 'Γ',
    21: 'Ω',
    22: 'Π',
    23: 'Ψ',
    24: 'Σ',
    25: 'Θ',
    31: 'Ê',
    65: 'À',
    73: 'Í',
    79: 'Ó',
    85: 'Ú',
    91: 'Ã',
    92: 'Õ',
    97: 'Â',
    105: 'í',
    111: 'ó',
    117: 'ú',
    123: 'ã',
    124: 'õ',
    127: 'â',
  },
};

const BASIC_ENCODE = new Map<string, number>();
for (let i = 0; i < BASIC_TABLE.length; i++) {
  if (i !== ESC) BASIC_ENCODE.set(BASIC_TABLE[i]!, i);
}

function invert(table: Record<number, string>): Map<string, number> {
  return new Map(Object.entries(table).map(([code, ch]) => [ch, Number(code)]));
}

const EXT_ENCODE = {
  default: invert(DEFAULT_EXTENSION),
  tr: invert(SINGLE_SHIFT_TABLES.tr),
  es: invert(SINGLE_SHIFT_TABLES.es),
  pt: invert(SINGLE_SHIFT_TABLES.pt),
};

const EXT_DECODE = {
  default: DEFAULT_EXTENSION,
  ...SINGLE_SHIFT_TABLES,
};

/** Septets used by a character (1 or 2), or `undefined` if it cannot be represented. */
export function gsm7CharCost(ch: string, shift?: NationalLanguage): 1 | 2 | undefined {
  if (BASIC_ENCODE.has(ch)) return 1;
  if (EXT_ENCODE[shift ?? 'default'].has(ch)) return 2;
  return undefined;
}

/** True when the whole text can be represented in GSM7 (with the given shift table). */
export function canEncodeGsm7(text: string, shift?: NationalLanguage): boolean {
  for (const ch of text) if (gsm7CharCost(ch, shift) === undefined) return false;
  return true;
}

/** Length in septets (extension characters count as 2). */
export function gsm7Length(text: string, shift?: NationalLanguage): number {
  let n = 0;
  for (const ch of text) {
    const cost = gsm7CharCost(ch, shift);
    if (cost === undefined) throw unrepresentable(ch);
    n += cost;
  }
  return n;
}

function unrepresentable(ch: string): SmppValidationError {
  const cp = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  return new SmppValidationError(
    `Character U+${cp} cannot be encoded in GSM 03.38`,
    'short_message',
    0x00000104,
  );
}

/** Encodes into unpacked septets. Throws if a character cannot be represented (no `?`). */
export function encodeGsm7(text: string, shift?: NationalLanguage): Buffer {
  const out: number[] = [];
  const ext = EXT_ENCODE[shift ?? 'default'];
  for (const ch of text) {
    const basic = BASIC_ENCODE.get(ch);
    if (basic !== undefined) {
      out.push(basic);
      continue;
    }
    const e = ext.get(ch);
    if (e === undefined) throw unrepresentable(ch);
    out.push(ESC, e);
  }
  return Buffer.from(out);
}

/** Decodes unpacked septets. Lenient: an invalid septet becomes U+FFFD. */
export function decodeGsm7(buf: Uint8Array, shift?: NationalLanguage): string {
  const ext = EXT_DECODE[shift ?? 'default'];
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === ESC) {
      const next = buf[i + 1];
      if (next === undefined) break;
      i++;
      // Unknown extension code: show the base table character (23.038 §6.2.1.1).
      out += ext[next] ?? (next < 0x80 && next !== ESC ? BASIC_TABLE[next] : '�');
      continue;
    }
    out += b < 0x80 ? BASIC_TABLE[b] : '�';
  }
  return out;
}

/**
 * Packs septets into octets (7 bits per character).
 * `fillBits`: leading padding bits, to align after a UDH.
 */
export function packSeptets(septets: Uint8Array, fillBits = 0): Buffer {
  const totalBits = fillBits + septets.length * 7;
  const out = Buffer.alloc(Math.ceil(totalBits / 8));
  let bit = fillBits;
  for (const s of septets) {
    const v = s & 0x7f;
    const byte = bit >> 3;
    const shift = bit & 7;
    out[byte]! |= (v << shift) & 0xff;
    if (shift > 1) out[byte + 1]! |= v >> (8 - shift);
    bit += 7;
  }
  return out;
}

/** Unpacks `count` septets (as many as possible when omitted). */
export function unpackSeptets(packed: Uint8Array, count?: number, fillBits = 0): Buffer {
  const max = Math.max(0, Math.floor((packed.length * 8 - fillBits) / 7));
  const n = Math.max(0, Math.min(count ?? max, max));
  const out = Buffer.alloc(n);
  let bit = fillBits;
  for (let i = 0; i < n; i++) {
    const byte = bit >> 3;
    const shift = bit & 7;
    let v = packed[byte]! >> shift;
    if (shift > 1) v |= (packed[byte + 1] ?? 0) << (8 - shift);
    out[i] = v & 0x7f;
    bit += 7;
  }
  return out;
}

export const GSM7_BASIC_TABLE = BASIC_TABLE;
