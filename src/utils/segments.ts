import { type DetectOptions, detectEncoding } from '../encoding/detect.js';
import { type NationalLanguage, gsm7CharCost } from '../encoding/gsm7.js';
import { type EncodingRegistry, type TextCodec, encodings } from '../encoding/registry.js';
import { SmppValidationError } from '../errors.js';

/**
 * Stratégie d'envoi des messages longs :
 * - `udh8` : UDH concaténation 8 bits (IEI 0x00), défaut ;
 * - `udh16` : UDH concaténation 16 bits (IEI 0x08) ;
 * - `sar` : TLV sar_msg_ref_num / sar_total_segments / sar_segment_seqnum ;
 * - `payload` : un seul PDU avec message_payload (le SMSC découpe).
 */
export type MultipartStrategy = 'udh8' | 'udh16' | 'sar' | 'payload';

export interface SegmentOptions extends DetectOptions {
  /** Encodage forcé (nom dans le registre). Erreur si le texte n'est pas représentable. */
  encoding?: string;
  /** Table de shift nationale forcée (GSM7 uniquement). */
  shift?: NationalLanguage;
  strategy?: MultipartStrategy;
  registry?: EncodingRegistry;
}

export interface SegmentInfo {
  encoding: string;
  shift?: NationalLanguage;
  dataCoding: number;
  strategy: MultipartStrategy;
  /** Nombre de segments sur l'interface radio. */
  segments: number;
  /** Longueur totale en unités (septets, octets ou unités UTF-16). */
  units: number;
  /** Capacité d'un segment, en unités. */
  perSegment: number;
  /** Unités encore disponibles dans le dernier segment. */
  remaining: number;
}

const SM_OCTETS = 140;

/** Taille de l'UDH (UDHL inclus) pour un segment. */
export function udhLength(multipart: boolean, strategy: MultipartStrategy, shift?: NationalLanguage): number {
  let ies = 0;
  if (multipart && (strategy === 'udh8' || strategy === 'payload')) ies += 5;
  if (multipart && strategy === 'udh16') ies += 6;
  if (shift) ies += 3;
  return ies === 0 ? 0 : ies + 1;
}

/** Capacité en unités d'un segment, compte tenu de l'UDH. */
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
  if (r.codec.unitBits === 16) return ch.length; // paire de substitution = 2 unités
  return r.codec.length(ch);
}

/** Calcule l'encodage, le nombre de segments et la place restante (§6.5). */
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
 * Découpe sans jamais couper une séquence d'échappement GSM ni une paire de substitution UTF-16 :
 * l'itération se fait par point de code et le coût de chaque caractère est indivisible.
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
  /** Texte de chaque segment (un seul pour `payload`). */
  parts: string[];
}

/** Découpe un texte en segments prêts à être encodés. */
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
