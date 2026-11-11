import { type NationalLanguage, canEncodeGsm7 } from './gsm7.js';
import { canEncodeLatin1 } from './latin1.js';

export type DetectedEncoding = 'gsm7' | 'latin1' | 'ucs2';

export interface DetectOptions {
  /**
   * Tables de shift nationales autorisées, par ordre de préférence.
   * Défaut : aucune (beaucoup de SMSC ne gèrent pas l'IE UDH 0x24).
   */
  shiftTables?: readonly NationalLanguage[];
  /**
   * Autorise Latin-1 (data_coding 0x03) avant UCS2.
   * Défaut : false (support inégal chez les opérateurs).
   */
  allowLatin1?: boolean;
}

export interface DetectionResult {
  encoding: DetectedEncoding;
  /** Table de shift nationale nécessaire, le cas échéant. */
  shift?: NationalLanguage;
}

/** Choisit l'encodage le plus compact capable de représenter le texte. */
export function detectEncoding(text: string, options: DetectOptions = {}): DetectionResult {
  if (canEncodeGsm7(text)) return { encoding: 'gsm7' };
  for (const shift of options.shiftTables ?? []) {
    if (canEncodeGsm7(text, shift)) return { encoding: 'gsm7', shift };
  }
  if (options.allowLatin1 && canEncodeLatin1(text)) return { encoding: 'latin1' };
  return { encoding: 'ucs2' };
}
