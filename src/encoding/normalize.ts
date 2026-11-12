import { type Gsm7Shift, canEncodeGsm7, gsm7CharCost } from './gsm7.js';

/**
 * How far `normalizeForGsm7` goes:
 * - `punctuation`: typographic characters only (curly quotes, dashes, ellipsis, special spaces,
 *   invisible characters…). The meaning of the text never changes.
 * - `transliterate`: also letters missing from GSM7, by dropping their accent (`ê` → `e`, `ç` → `c`)
 *   or spelling them out (`œ` → `oe`). The text stays readable but loses its accents.
 */
export type NormalizeMode = 'punctuation' | 'transliterate';

export interface Replacement {
  /** Position in the original text (UTF-16 index). */
  index: number;
  from: string;
  /** Replacement (empty for a removed invisible character). */
  to: string;
}

export interface NormalizeResult {
  text: string;
  replacements: Replacement[];
  /** The result can be encoded in GSM7 (with the given tables). */
  gsm7: boolean;
}

export interface NormalizeOptions {
  /** Default: `punctuation`. */
  mode?: NormalizeMode;
  /** National tables: a character they can encode is never replaced. */
  shift?: Gsm7Shift;
}

const PUNCTUATION: Readonly<Record<string, string>> = {
  // Quotes and apostrophes
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '´': "'",
  '`': "'",
  '‹': "'",
  '›': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '«': '"',
  '»': '"',
  // Dashes and minus
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '•': '-',
  // Other punctuation and symbols
  '…': '...',
  '‼': '!!',
  '⁄': '/',
  '×': 'x',
  '÷': '/',
  ˆ: '^',
  '˜': '~',
  '¦': '|',
  '·': '.',
  '™': 'TM',
  '©': '(c)',
  '®': '(R)',
  // Spaces
  '\t': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '　': ' ',
  ' ': '\n',
  ' ': '\n',
  // Invisible characters: removed
  '­': '',
  '​': '',
  '‌': '',
  '‍': '',
  '⁠': '',
  '﻿': '',
};

/** Letters with no accent to drop (NFD leaves them as they are). */
const LETTERS: Readonly<Record<string, string>> = {
  œ: 'oe',
  Œ: 'OE',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'TH',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ı: 'i',
};

const COMBINING_MARKS = /\p{Mn}/gu;

/**
 * Replaces characters missing from the GSM 03.38 alphabet with close GSM7 equivalents, so that a text
 * does not fall back to UCS2 (70 characters per SMS instead of 160) because of one curly apostrophe.
 * Characters GSM7 can already encode are never touched; characters with no equivalent (emoji, other
 * scripts) are left as they are.
 */
export function normalizeForGsm7(text: string, options: NormalizeOptions = {}): NormalizeResult {
  const mode = options.mode ?? 'punctuation';
  const shift = options.shift;
  const encodable = (s: string) => canEncodeGsm7(s, shift);
  const replacements: Replacement[] = [];
  let out = '';
  let index = 0;
  for (const ch of text) {
    let to: string | undefined;
    if (gsm7CharCost(ch, shift) === undefined) {
      const punct = PUNCTUATION[ch];
      if (punct !== undefined && encodable(punct)) to = punct;
      else if (mode === 'transliterate') to = transliterate(ch, encodable);
    }
    if (to === undefined) {
      out += ch;
    } else {
      out += to;
      replacements.push({ index, from: ch, to });
    }
    index += ch.length;
  }
  return { text: out, replacements, gsm7: encodable(out) };
}

function transliterate(ch: string, encodable: (s: string) => boolean): string | undefined {
  const letter = LETTERS[ch];
  if (letter !== undefined) return encodable(letter) ? letter : undefined;
  const stripped = ch.normalize('NFD').replace(COMBINING_MARKS, '');
  if (stripped.length > 0 && stripped !== ch && encodable(stripped)) return stripped;
  return undefined;
}

/** Characters of a text that GSM7 cannot encode (each listed once, in order of appearance). */
export function nonGsm7Characters(text: string, shift?: Gsm7Shift): string[] {
  const found = new Set<string>();
  for (const ch of text) if (gsm7CharCost(ch, shift) === undefined) found.add(ch);
  return [...found];
}
