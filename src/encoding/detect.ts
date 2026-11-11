import { type NationalLanguage, canEncodeGsm7, hasLockingShift } from './gsm7.js';
import { canEncodeLatin1 } from './latin1.js';

export type DetectedEncoding = 'gsm7' | 'latin1' | 'ucs2';

export interface DetectOptions {
  /**
   * National languages allowed, in order of preference (3GPP TS 23.038: tr, es, pt, bn, gu, hi, kn,
   * ml, or, pa, ta, te, ur). For each one, the single shift table alone is tried first (UDH IE 0x24,
   * 3 octets), then with the locking shift table (IE 0x25 as well, 6 octets).
   * Default: none (many SMSCs and handsets do not support national tables).
   */
  shiftTables?: readonly NationalLanguage[];
  /**
   * Allows Latin-1 (data_coding 0x03) before UCS2.
   * Default: false (uneven operator support).
   */
  allowLatin1?: boolean;
}

export interface DetectionResult {
  encoding: DetectedEncoding;
  /** National single shift table required, if any. */
  shift?: NationalLanguage;
  /** National locking shift table required, if any. */
  locking?: NationalLanguage;
}

/** Picks the most compact encoding able to represent the text. */
export function detectEncoding(text: string, options: DetectOptions = {}): DetectionResult {
  if (canEncodeGsm7(text)) return { encoding: 'gsm7' };
  const languages = options.shiftTables ?? [];
  for (const shift of languages) {
    if (canEncodeGsm7(text, shift)) return { encoding: 'gsm7', shift };
  }
  for (const lang of languages) {
    if (hasLockingShift(lang) && canEncodeGsm7(text, { single: lang, locking: lang })) {
      return { encoding: 'gsm7', shift: lang, locking: lang };
    }
  }
  if (options.allowLatin1 && canEncodeLatin1(text)) return { encoding: 'latin1' };
  return { encoding: 'ucs2' };
}
