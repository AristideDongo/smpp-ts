import { type NationalLanguage, canEncodeGsm7 } from './gsm7.js';
import { canEncodeLatin1 } from './latin1.js';

export type DetectedEncoding = 'gsm7' | 'latin1' | 'ucs2';

export interface DetectOptions {
  /**
   * National shift tables allowed, in order of preference.
   * Default: none (many SMSCs do not support UDH IE 0x24).
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
  /** National shift table required, if any. */
  shift?: NationalLanguage;
}

/** Picks the most compact encoding able to represent the text. */
export function detectEncoding(text: string, options: DetectOptions = {}): DetectionResult {
  if (canEncodeGsm7(text)) return { encoding: 'gsm7' };
  for (const shift of options.shiftTables ?? []) {
    if (canEncodeGsm7(text, shift)) return { encoding: 'gsm7', shift };
  }
  if (options.allowLatin1 && canEncodeLatin1(text)) return { encoding: 'latin1' };
  return { encoding: 'ucs2' };
}
