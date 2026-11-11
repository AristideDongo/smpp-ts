import {
  NATIONAL_LANGUAGE_ID,
  type NationalLanguage,
  decodeGsm7,
  encodeGsm7,
  packSeptets,
  unpackSeptets,
} from '../encoding/gsm7.js';
import { type EncodingRegistry, encodings } from '../encoding/registry.js';
import { ESM_CLASS, UDH_IEI } from '../protocol/constants.js';
import { type MultipartStrategy, type SegmentOptions, splitText } from './segments.js';

// ---------------------------------------------------------------------------
// UDH
// ---------------------------------------------------------------------------

export interface InformationElement {
  iei: number;
  data: Buffer;
}

export interface ConcatInfo {
  reference: number;
  total: number;
  sequence: number;
}

export interface ParsedUdh {
  /** Taille totale de l'UDH, UDHL compris. */
  length: number;
  elements: InformationElement[];
  concat?: ConcatInfo;
  /** Table de single shift nationale annoncée. */
  shift?: NationalLanguage;
}

const LANGUAGE_BY_ID = new Map<number, NationalLanguage>(
  (Object.entries(NATIONAL_LANGUAGE_ID) as [NationalLanguage, number][]).map(([k, v]) => [v, k]),
);

export function buildUdh(elements: InformationElement[]): Buffer {
  const body = Buffer.concat(
    elements.map((e) => Buffer.concat([Buffer.from([e.iei, e.data.length]), e.data])),
  );
  return Buffer.concat([Buffer.from([body.length]), body]);
}

/** Analyse un UDH. Renvoie `undefined` s'il est malformé (jamais d'exception). */
export function parseUdh(buf: Uint8Array): ParsedUdh | undefined {
  if (buf.length < 1) return undefined;
  const udhl = buf[0]!;
  if (udhl + 1 > buf.length) return undefined;
  const elements: InformationElement[] = [];
  const result: ParsedUdh = { length: udhl + 1, elements };
  let i = 1;
  while (i < udhl + 1) {
    if (i + 2 > udhl + 1) return undefined;
    const iei = buf[i]!;
    const len = buf[i + 1]!;
    if (i + 2 + len > udhl + 1) return undefined;
    const data = Buffer.from(buf.subarray(i + 2, i + 2 + len));
    elements.push({ iei, data });
    if (iei === UDH_IEI.CONCAT_8BIT && len === 3) {
      result.concat = { reference: data[0]!, total: data[1]!, sequence: data[2]! };
    } else if (iei === UDH_IEI.CONCAT_16BIT && len === 4) {
      result.concat = { reference: data.readUInt16BE(0), total: data[2]!, sequence: data[3]! };
    } else if (iei === UDH_IEI.NATIONAL_SINGLE_SHIFT && len === 1) {
      const lang = LANGUAGE_BY_ID.get(data[0]!);
      if (lang) result.shift = lang;
    }
    i += 2 + len;
  }
  return result;
}

/**
 * Vrai si l'esm_class annonce un UDH.
 * BUG-04 : l'indicateur Kannel (0x43) contient le bit UDHI (0x40) ; on teste ce bit,
 * ce qui couvre les deux variantes sans faux positif sur les bits de mode (0x01–0x03).
 */
export function hasUdhIndicator(esmClass: number): boolean {
  return (esmClass & ESM_CLASS.UDH_INDICATOR) !== 0;
}

// ---------------------------------------------------------------------------
// Construction des segments sortants
// ---------------------------------------------------------------------------

export interface OutboundPart {
  /** Contenu à placer dans short_message (absent si message_payload). */
  short_message?: Buffer;
  message_payload?: Buffer;
  esm_class: number;
  data_coding: number;
  sar_msg_ref_num?: number;
  sar_total_segments?: number;
  sar_segment_seqnum?: number;
}

export interface BuildPartsOptions extends SegmentOptions {
  /** Référence de concaténation (tournante par session). */
  reference: number;
  /** Compacte les septets GSM7 (rare en SMPP). Défaut : false. */
  packGsm7?: boolean;
  /** esm_class de base (le bit UDHI est ajouté si nécessaire). */
  esmClass?: number;
}

export interface BuiltParts {
  encoding: string;
  shift?: NationalLanguage;
  dataCoding: number;
  strategy: MultipartStrategy;
  parts: OutboundPart[];
}

/** Découpe et encode un texte en PDU prêts à envoyer. */
export function buildParts(text: string, options: BuildPartsOptions): BuiltParts {
  const split = splitText(text, options);
  const { codec, shift, strategy } = split;
  const total = split.parts.length;
  const multipart = total > 1;
  const baseEsm = options.esmClass ?? 0;
  const reference = options.reference;

  const encodeBody = (part: string): Buffer =>
    codec.name === 'gsm7' ? encodeGsm7(part, shift) : codec.encode(part);

  const parts = split.parts.map((part, idx): OutboundPart => {
    const ies: InformationElement[] = [];
    if (multipart && strategy === 'udh8') {
      ies.push({ iei: UDH_IEI.CONCAT_8BIT, data: Buffer.from([reference & 0xff, total, idx + 1]) });
    } else if (multipart && strategy === 'udh16') {
      const d = Buffer.alloc(4);
      d.writeUInt16BE(reference & 0xffff, 0);
      d[2] = total;
      d[3] = idx + 1;
      ies.push({ iei: UDH_IEI.CONCAT_16BIT, data: d });
    }
    if (shift)
      ies.push({ iei: UDH_IEI.NATIONAL_SINGLE_SHIFT, data: Buffer.from([NATIONAL_LANGUAGE_ID[shift]]) });

    const udh = ies.length > 0 ? buildUdh(ies) : undefined;
    let body = encodeBody(part);
    if (codec.name === 'gsm7' && options.packGsm7) {
      const fill = udh ? (7 - ((udh.length * 8) % 7)) % 7 : 0;
      body = packSeptets(body, fill);
    }
    const content = udh ? Buffer.concat([udh, body]) : body;
    const out: OutboundPart = {
      esm_class: udh ? baseEsm | ESM_CLASS.UDH_INDICATOR : baseEsm,
      data_coding: codec.dataCoding,
    };
    if (strategy === 'payload') out.message_payload = content;
    else out.short_message = content;
    if (multipart && strategy === 'sar') {
      out.sar_msg_ref_num = reference & 0xffff;
      out.sar_total_segments = total;
      out.sar_segment_seqnum = idx + 1;
    }
    return out;
  });

  return {
    encoding: codec.name,
    dataCoding: codec.dataCoding,
    strategy,
    parts,
    ...(shift ? { shift } : {}),
  };
}

// ---------------------------------------------------------------------------
// Décodage des messages entrants
// ---------------------------------------------------------------------------

export interface MessageContentInput {
  esm_class: number;
  data_coding: number;
  short_message?: Buffer;
  message_payload?: Buffer;
  sar_msg_ref_num?: number;
  sar_total_segments?: number;
  sar_segment_seqnum?: number;
}

export interface DecodedContent {
  /** Corps sans l'UDH (septets non compactés pour GSM7). */
  body: Buffer;
  /** Texte décodé, ou `undefined` pour un contenu binaire. */
  text?: string;
  udh?: ParsedUdh;
  concat?: ConcatInfo;
  encoding?: string;
}

export interface DecodeContentOptions {
  registry?: EncodingRegistry;
  /** Les septets GSM7 entrants sont compactés. Défaut : false. */
  packedGsm7?: boolean;
}

/** Extrait l'UDH et décode le texte d'un deliver_sm / data_sm / submit_sm. */
export function decodeMessageContent(
  pdu: MessageContentInput,
  options: DecodeContentOptions = {},
): DecodedContent {
  const registry = options.registry ?? encodings;
  const raw =
    pdu.message_payload && pdu.message_payload.length > 0
      ? pdu.message_payload
      : (pdu.short_message ?? Buffer.alloc(0));
  const codec = registry.forDataCoding(pdu.data_coding);
  let udh: ParsedUdh | undefined;
  let body = raw;
  if (hasUdhIndicator(pdu.esm_class)) {
    udh = parseUdh(raw);
    if (udh) body = raw.subarray(udh.length);
  }
  const isGsm = codec?.name === 'gsm7';
  // BUG-05 : le traitement GSM (septets, bits de bourrage) ne s'applique qu'aux encodages GSM.
  if (isGsm && options.packedGsm7) {
    const fill = udh ? (7 - ((udh.length * 8) % 7)) % 7 : 0;
    body = unpackSeptets(raw, undefined, fill + (udh ? udh.length * 8 : 0));
  }
  const result: DecodedContent = { body: Buffer.from(body) };
  if (udh) result.udh = udh;
  if (codec) {
    result.encoding = codec.name;
    result.text = isGsm ? decodeGsm7(body, udh?.shift) : codec.decode(body);
  }
  const concat =
    udh?.concat ??
    (pdu.sar_msg_ref_num !== undefined &&
    pdu.sar_total_segments !== undefined &&
    pdu.sar_segment_seqnum !== undefined
      ? { reference: pdu.sar_msg_ref_num, total: pdu.sar_total_segments, sequence: pdu.sar_segment_seqnum }
      : undefined);
  if (concat && concat.total > 1) result.concat = concat;
  return result;
}

// ---------------------------------------------------------------------------
// Réassemblage
// ---------------------------------------------------------------------------

export interface ReassemblySegment<T = unknown> {
  source: string;
  destination: string;
  concat: ConcatInfo;
  body: Buffer;
  dataCoding: number;
  shift?: NationalLanguage;
  /** Donnée libre associée (ex. le PDU d'origine). */
  meta: T;
}

export interface ReassembledMessage<T = unknown> {
  source: string;
  destination: string;
  reference: number;
  total: number;
  /** Texte complet (ou partiel pour un message expiré), `undefined` si binaire. */
  text?: string;
  body: Buffer;
  dataCoding: number;
  /** Segments reçus, dans l'ordre. */
  segments: ReassemblySegment<T>[];
  /** Numéros de segments manquants (message partiel uniquement). */
  missing: number[];
}

export interface ReassemblerOptions<T> {
  /** Durée de vie d'un message incomplet. Défaut : 5 min (SEC-04). */
  ttl?: number;
  /** Nombre max de messages incomplets en mémoire. Défaut : 1 000 (SEC-04). */
  maxBuffers?: number;
  registry?: EncodingRegistry;
  /** Appelé quand un message incomplet expire ou est évincé. */
  onPartial?: (msg: ReassembledMessage<T>) => void;
}

interface Bucket<T> {
  segments: Map<number, ReassemblySegment<T>>;
  total: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Réassemble les segments par (source, destination, référence). Mémoire bornée. */
export class Reassembler<T = unknown> {
  private readonly buckets = new Map<string, Bucket<T>>();
  private readonly ttl: number;
  private readonly maxBuffers: number;
  private readonly registry: EncodingRegistry;

  constructor(private readonly options: ReassemblerOptions<T> = {}) {
    this.ttl = options.ttl ?? 5 * 60_000;
    this.maxBuffers = options.maxBuffers ?? 1000;
    this.registry = options.registry ?? encodings;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Ajoute un segment. Renvoie le message complet quand tous les segments sont arrivés. */
  add(segment: ReassemblySegment<T>): ReassembledMessage<T> | undefined {
    const { concat } = segment;
    if (concat.total < 1 || concat.sequence < 1 || concat.sequence > concat.total) return undefined;
    const key = `${segment.source}\u0000${segment.destination}\u0000${concat.reference}\u0000${concat.total}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuffers) this.evictOldest();
      const timer = setTimeout(() => this.expire(key), this.ttl);
      timer.unref?.();
      bucket = { segments: new Map(), total: concat.total, timer };
      this.buckets.set(key, bucket);
    }
    bucket.segments.set(concat.sequence, segment); // doublon : le dernier gagne
    if (bucket.segments.size < bucket.total) return undefined;
    clearTimeout(bucket.timer);
    this.buckets.delete(key);
    return this.assemble(bucket, segment);
  }

  /** Vide les buffers (sans émettre de messages partiels). */
  clear(): void {
    for (const b of this.buckets.values()) clearTimeout(b.timer);
    this.buckets.clear();
  }

  private evictOldest(): void {
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.expire(oldest.value);
  }

  private expire(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    clearTimeout(bucket.timer);
    this.buckets.delete(key);
    const any = bucket.segments.values().next().value;
    if (any) this.options.onPartial?.(this.assemble(bucket, any));
  }

  private assemble(bucket: Bucket<T>, sample: ReassemblySegment<T>): ReassembledMessage<T> {
    const segments: ReassemblySegment<T>[] = [];
    const missing: number[] = [];
    for (let i = 1; i <= bucket.total; i++) {
      const s = bucket.segments.get(i);
      if (s) segments.push(s);
      else missing.push(i);
    }
    const body = Buffer.concat(segments.map((s) => s.body));
    const codec = this.registry.forDataCoding(sample.dataCoding);
    const msg: ReassembledMessage<T> = {
      source: sample.source,
      destination: sample.destination,
      reference: sample.concat.reference,
      total: bucket.total,
      body,
      dataCoding: sample.dataCoding,
      segments,
      missing,
    };
    if (codec) msg.text = codec.name === 'gsm7' ? decodeGsm7(body, sample.shift) : codec.decode(body);
    return msg;
  }
}
