import { type DetectOptions, detectEncoding } from '../encoding/detect.js';
import { type NationalLanguage, gsm7CharCost } from '../encoding/gsm7.js';
import { type EncodingRegistry, type TextCodec, encodings } from '../encoding/registry.js';
import { SmppValidationError } from '../errors.js';

/**
 * Long message strategy:
 * - `udh8`: 8-bit concatenation UDH (IEI 0x00), default;
 * - `udh16`: 16-bit concatenation UDH (IEI 0x08);
 * - `sar`: sar_msg_ref_num / sar_total_segments / sar_segment_seqnum TLVs;
 * - `payload`: a single PDU with message_payload (the SMSC splits it).
 */
export type MultipartStrategy = 'udh8' | 'udh16' | 'sar' | 'payload';

export interface SegmentOptions extends DetectOptions {
  /** Forced encoding (registry name). Throws if the text cannot be represented. */
  encoding?: string;
  /** Forced national shift table (GSM7 only). */
  shift?: NationalLanguage;
  strategy?: MultipartStrategy;
  registry?: EncodingRegistry;
}

export interface SegmentInfo {
  encoding: string;
  shift?: NationalLanguage;
  dataCoding: number;
  strategy: MultipartStrategy;
  /** Number of segments on the radio interface. */
  segments: number;
  /** Total length in units (septets, octets or UTF-16 code units). */
  units: number;
  /** Capacity of one segment, in units. */
  perSegment: number;
  /** Units still available in the last segment. */
  remaining: number;
}

const SM_OCTETS = 140;

/** UDH size (UDHL included) for one segment. */
export function udhLength(multipart: boolean, strategy: MultipartStrategy, shift?: NationalLanguage): number {
  let ies = 0;
  if (multipart && (strategy === 'udh8' || strategy === 'payload')) ies += 5;
  if (multipart && strategy === 'udh16') ies += 6;
  if (shift) ies += 3;
  return ies === 0 ? 0 : ies + 1;
}

/** Capacity of one segment in units, accounting for the UDH. */
export function segmentCapacity(unitBits: 7 | 8 | 16, udhBytes: number): number {
  const octets = SM_OCTETS - udhBytes;
  if (unitBits === 7) return Math.floor((octets * 8) / 7);
  if (unitBits === 8) return octets;
  return Math.floor(octets / 2);
}

interface Resolved {
  codec: TextCodec;
  shift?: NationalLanguage;
}

function resolve(text: string, options: SegmentOptions): Resolved {
  const registry = options.registry ?? encodings;
  if (options.encoding) {
    const codec = registry.get(options.encoding);
    const shift = codec.name === 'gsm7' ? options.shift : undefined;
    const ok =
      codec.name === 'gsm7'
        ? [...text].every((c) => gsm7CharCost(c, shift) !== undefined)
        : codec.canEncode(text);
    if (!ok) {
      throw new SmppValidationError(
        `Text cannot be represented with encoding ${codec.name}`,
        'short_message',
        0x00000104,
      );
    }
    return shift ? { codec, shift } : { codec };
  }
  const detected = detectEncoding(text, options);
  const codec = registry.get(detected.encoding);
  return detected.shift ? { codec, shift: detected.shift } : { codec };
}

function charCost(ch: string, r: Resolved): number {
  if (r.codec.name === 'gsm7') return gsm7CharCost(ch, r.shift) ?? 1;
  if (r.codec.unitBits === 16) return ch.length; // surrogate pair = 2 units
  return r.codec.length(ch);
}

/** Computes the encoding, the number of segments and the remaining room. */
export function countSegments(text: string, options: SegmentOptions = {}): SegmentInfo {
  const r = resolve(text, options);
  const strategy = options.strategy ?? 'udh8';
  let units = 0;
  for (const ch of text) units += charCost(ch, r);

  const single = segmentCapacity(r.codec.unitBits, udhLength(false, strategy, r.shift));
  const base = {
    encoding: r.codec.name,
    dataCoding: r.codec.dataCoding,
    strategy,
    units,
    ...(r.shift ? { shift: r.shift } : {}),
  };
  if (units <= single) {
    return { ...base, segments: 1, perSegment: single, remaining: single - units };
  }
  const multi = segmentCapacity(r.codec.unitBits, udhLength(true, strategy, r.shift));
  const parts = splitByCost(text, r, multi);
  const last = parts[parts.length - 1] ?? '';
  let lastUnits = 0;
  for (const ch of last) lastUnits += charCost(ch, r);
  return { ...base, segments: parts.length, perSegment: multi, remaining: multi - lastUnits };
}

/**
 * Splits without ever breaking a GSM escape sequence or a UTF-16 surrogate pair:
 * iteration is per code point and each character's cost is indivisible.
 */
function splitByCost(text: string, r: Resolved, capacity: number): string[] {
  const parts: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of text) {
    const cost = charCost(ch, r);
    if (used + cost > capacity) {
      parts.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += cost;
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  return parts;
}

export interface SplitResult {
  codec: TextCodec;
  shift?: NationalLanguage;
  strategy: MultipartStrategy;
  /** Text of each segment (just one for `payload`). */
  parts: string[];
}

/** Splits a text into segments ready to encode. */
export function splitText(text: string, options: SegmentOptions = {}): SplitResult {
  const r = resolve(text, options);
  const strategy = options.strategy ?? 'udh8';
  const base = { codec: r.codec, strategy, ...(r.shift ? { shift: r.shift } : {}) };
  if (strategy === 'payload') return { ...base, parts: [text] };
  let units = 0;
  for (const ch of text) units += charCost(ch, r);
  const single = segmentCapacity(r.codec.unitBits, udhLength(false, strategy, r.shift));
  if (units <= single) return { ...base, parts: [text] };
  const multi = segmentCapacity(r.codec.unitBits, udhLength(true, strategy, r.shift));
  const parts = splitByCost(text, r, multi);
  if (parts.length > 255) {
    throw new SmppValidationError(
      `Message too long (${parts.length} segments, max 255)`,
      'short_message',
      0x01,
    );
  }
  return { ...base, parts };
}
