import { SmppValidationError } from '../errors.js';
import {
  LOCKING_SHIFT,
  NATIONAL_LANGUAGE_IDS,
  type NationalLanguage,
  SINGLE_SHIFT,
} from './gsm7-national.js';

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
const DEFAULT_EXTENSION: Readonly<Record<number, string>> = {
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

export type { NationalLanguage };

/** Language identifiers (3GPP TS 23.038 §6.2.1.2.4), value of UDH IE 0x24 / 0x25. */
export const NATIONAL_LANGUAGE_ID: Readonly<Record<NationalLanguage, number>> = NATIONAL_LANGUAGE_IDS;

/** Every national language with a single shift table (13, 3GPP TS 23.038 Release 9+). */
export const NATIONAL_LANGUAGES: readonly NationalLanguage[] = Object.keys(
  NATIONAL_LANGUAGE_IDS,
) as NationalLanguage[];

/**
 * National tables used for a text:
 * - `single`: single shift table (IE 0x24), replaces the extension table (characters after ESC, 2 septets);
 * - `locking`: locking shift table (IE 0x25), replaces the default alphabet (1 septet).
 * A plain language code means `{ single: code }`.
 */
export interface Gsm7Tables {
  single?: NationalLanguage;
  locking?: NationalLanguage;
}

export type Gsm7Shift = NationalLanguage | Gsm7Tables;

/** True when 23.038 defines a locking shift table for the language (all but Spanish). */
export function hasLockingShift(language: NationalLanguage): boolean {
  return LOCKING_SHIFT[language] !== undefined;
}

function tablesOf(shift: Gsm7Shift | undefined): Gsm7Tables {
  return typeof shift === 'string' ? { single: shift } : (shift ?? {});
}

interface Codec {
  /** Septet → character (128 entries; undefined = not defined in the table). */
  base: ReadonlyArray<string | undefined>;
  ext: Readonly<Record<number, string>>;
  baseEncode: ReadonlyMap<string, number>;
  extEncode: ReadonlyMap<string, number>;
}

const BASIC_ARRAY: ReadonlyArray<string | undefined> = [...BASIC_TABLE];

function encodeMap(entries: Iterable<[number, string | undefined]>): Map<string, number> {
  const map = new Map<string, number>();
  for (const [code, ch] of entries) {
    // First position wins (23.038 lists a few characters twice); ESC is never a character.
    if (ch === undefined || code === ESC || map.has(ch)) continue;
    map.set(ch, code);
  }
  return map;
}

const codecs = new Map<string, Codec>();

function codecFor(shift: Gsm7Shift | undefined): Codec {
  const { single, locking } = tablesOf(shift);
  const key = `${locking ?? ''}/${single ?? ''}`;
  let codec = codecs.get(key);
  if (codec) return codec;
  const lockingTable = locking ? LOCKING_SHIFT[locking] : undefined;
  if (locking && !lockingTable) {
    throw new SmppValidationError(`No locking shift table for language "${locking}"`, 'shift');
  }
  const base = lockingTable
    ? Array.from({ length: 128 }, (_, i) => (i === ESC ? '\u001b' : lockingTable[i]))
    : BASIC_ARRAY;
  const ext = single ? SINGLE_SHIFT[single] : DEFAULT_EXTENSION;
  codec = {
    base,
    ext,
    baseEncode: encodeMap(base.map((ch, i) => [i, ch] as [number, string | undefined])),
    extEncode: encodeMap(Object.entries(ext).map(([k, v]) => [Number(k), v] as [number, string])),
  };
  codecs.set(key, codec);
  return codec;
}

/** Septets used by a character (1 or 2), or `undefined` if it cannot be represented. */
export function gsm7CharCost(ch: string, shift?: Gsm7Shift): 1 | 2 | undefined {
  const codec = codecFor(shift);
  if (codec.baseEncode.has(ch)) return 1;
  if (codec.extEncode.has(ch)) return 2;
  return undefined;
}

/** True when the whole text can be represented in GSM7 (with the given national tables). */
export function canEncodeGsm7(text: string, shift?: Gsm7Shift): boolean {
  for (const ch of text) if (gsm7CharCost(ch, shift) === undefined) return false;
  return true;
}

/** Length in septets (extension characters count as 2). */
export function gsm7Length(text: string, shift?: Gsm7Shift): number {
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
export function encodeGsm7(text: string, shift?: Gsm7Shift): Buffer {
  const out: number[] = [];
  const { baseEncode, extEncode } = codecFor(shift);
  for (const ch of text) {
    const basic = baseEncode.get(ch);
    if (basic !== undefined) {
      out.push(basic);
      continue;
    }
    const e = extEncode.get(ch);
    if (e === undefined) throw unrepresentable(ch);
    out.push(ESC, e);
  }
  return Buffer.from(out);
}

/** Decodes unpacked septets. Lenient: an invalid or undefined septet becomes U+FFFD. */
export function decodeGsm7(buf: Uint8Array, shift?: Gsm7Shift): string {
  const { base, ext } = codecFor(shift);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === ESC) {
      const next = buf[i + 1];
      if (next === undefined) break;
      i++;
      // Unknown extension code: show the base table character (23.038 §6.2.1.1).
      out += ext[next] ?? (next < 0x80 && next !== ESC ? (base[next] ?? '�') : '�');
      continue;
    }
    out += b < 0x80 ? (base[b] ?? '�') : '�';
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
