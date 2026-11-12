import {
  type NormalizeMode,
  type Replacement,
  nonGsm7Characters,
  normalizeForGsm7,
} from '../encoding/normalize.js';
import { encodings } from '../encoding/registry.js';
import { type SegmentInfo, type SegmentOptions, countSegments } from './segments.js';

export interface PrepareTextOptions extends SegmentOptions {
  /** GSM7 normalization (see `normalizeForGsm7`). Default: `false`. */
  normalize?: false | NormalizeMode;
}

export interface PreparedText {
  /** Text to send: the normalized one when it needs fewer segments, the original otherwise. */
  text: string;
  /** Replacements applied (empty when the original text is kept). */
  replacements: Replacement[];
}

/** Segments for a text, or `undefined` when it cannot be represented (forced encoding). */
function segmentsOf(text: string, options: SegmentOptions): SegmentInfo | undefined {
  try {
    return countSegments(text, options);
  } catch {
    return undefined;
  }
}

/**
 * Applies GSM7 normalization when it pays off: the normalized text is kept only if it needs fewer
 * segments than the original (or if the original cannot be encoded with the forced encoding).
 * A text that stays in UCS2 anyway (emoji…) is sent unchanged.
 */
export function prepareText(text: string, options: PrepareTextOptions = {}): PreparedText {
  const mode = options.normalize;
  const unchanged: PreparedText = { text, replacements: [] };
  if (!mode) return unchanged;
  // A forced non-GSM encoding (UCS2…) represents the text as it is: nothing to gain.
  if (options.encoding && (options.registry ?? encodings).get(options.encoding).name !== 'gsm7') {
    return unchanged;
  }
  const tables = {
    ...(options.shift ? { single: options.shift } : {}),
    ...(options.locking ? { locking: options.locking } : {}),
  };
  const normalized = normalizeForGsm7(text, { mode, shift: tables });
  if (normalized.replacements.length === 0) return unchanged;
  const after = segmentsOf(normalized.text, options);
  if (!after) return unchanged;
  const before = segmentsOf(text, options);
  if (before && before.segments <= after.segments) return unchanged;
  return { text: normalized.text, replacements: normalized.replacements };
}

export interface TextEstimate extends SegmentInfo {
  /** Text that would be sent (after normalization, if it applies). */
  text: string;
  /**
   * Characters of the original text missing from GSM7 (default tables): they are what pushes a text
   * to UCS2 or Latin-1. Empty for a pure GSM7 text.
   */
  nonGsm7: string[];
  /** Normalization applied. */
  replacements: Replacement[];
  /** Segments of the original text, without normalization. */
  segmentsWithoutNormalization: number;
  /**
   * Set when a normalization mode not requested here would need fewer segments: what it would give.
   * `transliterate` is suggested only when `punctuation` is not enough.
   */
  suggestion?: { normalize: NormalizeMode; segments: number; encoding: string };
}

/**
 * Cost of a text before sending it: encoding, segments (each billed as one SMS), the characters that
 * force UCS2, and what GSM7 normalization saves.
 */
export function estimateText(text: string, options: PrepareTextOptions = {}): TextEstimate {
  const original = countSegments(text, options);
  const prepared = prepareText(text, options);
  const info = prepared.text === text ? original : countSegments(prepared.text, options);
  const estimate: TextEstimate = {
    ...info,
    text: prepared.text,
    nonGsm7: nonGsm7Characters(text),
    replacements: prepared.replacements,
    segmentsWithoutNormalization: original.segments,
  };
  const modes: NormalizeMode[] =
    options.normalize === 'transliterate'
      ? []
      : options.normalize === 'punctuation'
        ? ['transliterate']
        : ['punctuation', 'transliterate'];
  for (const mode of modes) {
    const alt = prepareText(text, { ...options, normalize: mode });
    if (alt.replacements.length === 0) continue;
    const altInfo = countSegments(alt.text, options);
    if (altInfo.segments < info.segments) {
      estimate.suggestion = { normalize: mode, segments: altInfo.segments, encoding: altInfo.encoding };
      break;
    }
  }
  return estimate;
}
