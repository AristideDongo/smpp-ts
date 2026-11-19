import {
  type Gsm7Tables,
  NATIONAL_LANGUAGE_ID,
  type NationalLanguage,
  decodeGsm7,
  encodeGsm7,
  hasLockingShift,
  packSeptets,
  unpackSeptets,
} from '../encoding/gsm7.js';
import { type EncodingRegistry, encodings } from '../encoding/registry.js';
import { SmppValidationError } from '../errors.js';
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

/** Application ports of a binary message (UDH IE 0x04 or 0x05). */
export interface PortInfo {
  source: number;
  destination: number;
  /** Port width announced by the IE. */
  bits: 8 | 16;
}

export interface ParsedUdh {
  /** Total UDH size, UDHL included. */
  length: number;
  elements: InformationElement[];
  concat?: ConcatInfo;
  /** Application port addressing, when the segment carries it. */
  ports?: PortInfo;
  /** Announced national single shift table (IE 0x24). */
  shift?: NationalLanguage;
  /** Announced national locking shift table (IE 0x25). */
  locking?: NationalLanguage;
}

const LANGUAGE_BY_ID = new Map<number, NationalLanguage>(
  (Object.entries(NATIONAL_LANGUAGE_ID) as [NationalLanguage, number][]).map(([k, v]) => [v, k]),
);

/** National tables announced by a UDH or carried by a segment. */
function gsm7TablesOf(src: { shift?: NationalLanguage; locking?: NationalLanguage } | undefined): Gsm7Tables {
  return {
    ...(src?.shift ? { single: src.shift } : {}),
    ...(src?.locking ? { locking: src.locking } : {}),
  };
}

export function buildUdh(elements: InformationElement[]): Buffer {
  const body = Buffer.concat(
    elements.map((e) => Buffer.concat([Buffer.from([e.iei, e.data.length]), e.data])),
  );
  return Buffer.concat([Buffer.from([body.length]), body]);
}

/** Parses a UDH. Returns `undefined` when malformed (never throws). */
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
    } else if (iei === UDH_IEI.PORTS_8BIT && len === 2) {
      result.ports = { destination: data[0]!, source: data[1]!, bits: 8 };
    } else if (iei === UDH_IEI.PORTS_16BIT && len === 4) {
      result.ports = { destination: data.readUInt16BE(0), source: data.readUInt16BE(2), bits: 16 };
    } else if (iei === UDH_IEI.NATIONAL_SINGLE_SHIFT && len === 1) {
      const lang = LANGUAGE_BY_ID.get(data[0]!);
      if (lang) result.shift = lang;
    } else if (iei === UDH_IEI.NATIONAL_LOCKING_SHIFT && len === 1) {
      const lang = LANGUAGE_BY_ID.get(data[0]!);
      if (lang && hasLockingShift(lang)) result.locking = lang;
    }
    i += 2 + len;
  }
  return result;
}

/**
 * True when esm_class announces a UDH.
 * BUG-04: the Kannel indicator (0x43) includes the UDHI bit (0x40); testing that bit
 * covers both variants without false positives on the mode bits (0x01–0x03).
 */
export function hasUdhIndicator(esmClass: number): boolean {
  return (esmClass & ESM_CLASS.UDH_INDICATOR) !== 0;
}

// ---------------------------------------------------------------------------
// Building outgoing segments
// ---------------------------------------------------------------------------

export interface OutboundPart {
  /** Content for short_message (absent when message_payload is used). */
  short_message?: Buffer;
  message_payload?: Buffer;
  esm_class: number;
  data_coding: number;
  sar_msg_ref_num?: number;
  sar_total_segments?: number;
  sar_segment_seqnum?: number;
}

export interface BuildPartsOptions extends SegmentOptions {
  /** Concatenation reference (rotating per session). */
  reference: number;
  /** Packs GSM7 septets (rare in SMPP). Default: false. */
  packGsm7?: boolean;
  /** Base esm_class (the UDHI bit is added when needed). */
  esmClass?: number;
}

export interface BuiltParts {
  encoding: string;
  shift?: NationalLanguage;
  locking?: NationalLanguage;
  dataCoding: number;
  strategy: MultipartStrategy;
  parts: OutboundPart[];
}

/** Splits and encodes a text into PDUs ready to send. */
export function buildParts(text: string, options: BuildPartsOptions): BuiltParts {
  const split = splitText(text, options);
  const { codec, shift, locking, strategy } = split;
  const tables = { ...(shift ? { single: shift } : {}), ...(locking ? { locking } : {}) };
  const total = split.parts.length;
  const multipart = total > 1;
  const baseEsm = options.esmClass ?? 0;
  const reference = options.reference;

  const encodeBody = (part: string): Buffer =>
    codec.name === 'gsm7' ? encodeGsm7(part, tables) : codec.encode(part);

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
    if (locking)
      ies.push({ iei: UDH_IEI.NATIONAL_LOCKING_SHIFT, data: Buffer.from([NATIONAL_LANGUAGE_ID[locking]]) });

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
    ...(locking ? { locking } : {}),
  };
}

/** Maximum payload of one segment, UDH included (3GPP TS 23.040). */
const SM_OCTETS = 140;

export interface BuildBinaryPartsOptions {
  /** Concatenation reference (rotating per session). */
  reference: number;
  /** `udh8` (default), `udh16`, `sar` or `payload`. */
  strategy?: MultipartStrategy;
  /** Destination application port (WAP push: 2948). */
  destPort?: number;
  /** Source application port. */
  sourcePort?: number;
  /** Port width. Default: 8 when both ports fit in a byte, 16 otherwise. */
  portBits?: 8 | 16;
  /** `data_coding`. Default: 0x04 (8-bit binary). */
  dataCoding?: number;
  /** Base esm_class (the UDHI bit is added when a UDH is needed). */
  esmClass?: number;
}

export interface BuiltBinaryParts {
  dataCoding: number;
  strategy: MultipartStrategy;
  parts: OutboundPart[];
  /** UDH size of each segment, 0 without one. */
  udhLength: number;
}

/** Port addressing IE, when ports are given. */
function portsElement(options: BuildBinaryPartsOptions): InformationElement | undefined {
  const { sourcePort, destPort } = options;
  if (sourcePort === undefined && destPort === undefined) return undefined;
  const source = sourcePort ?? 0;
  const destination = destPort ?? 0;
  for (const [name, value] of [
    ['sourcePort', source],
    ['destPort', destination],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new SmppValidationError(`${name} must be an integer between 0 and 65535`, name);
    }
  }
  const bits = options.portBits ?? (source <= 0xff && destination <= 0xff ? 8 : 16);
  if (bits === 8) {
    if (source > 0xff || destination > 0xff) {
      throw new SmppValidationError('8-bit ports must be between 0 and 255', 'portBits');
    }
    // Destination first (3GPP TS 23.040 §9.2.3.24.3).
    return { iei: UDH_IEI.PORTS_8BIT, data: Buffer.from([destination, source]) };
  }
  const data = Buffer.alloc(4);
  data.writeUInt16BE(destination, 0);
  data.writeUInt16BE(source, 2);
  return { iei: UDH_IEI.PORTS_16BIT, data };
}

/**
 * Splits binary content into segments ready to send: WAP push, a vCard, an OTA configuration,
 * anything that is not text. Concatenation and application ports go in the UDH, which no caller
 * then has to build by hand.
 */
export function buildBinaryParts(data: Uint8Array, options: BuildBinaryPartsOptions): BuiltBinaryParts {
  const strategy = options.strategy ?? 'udh8';
  const dataCoding = options.dataCoding ?? 0x04;
  const baseEsm = options.esmClass ?? 0;
  const ports = portsElement(options);
  const body = Buffer.from(data);

  const build = (chunk: Buffer, ies: InformationElement[]): OutboundPart => {
    const udh = ies.length > 0 ? buildUdh(ies) : undefined;
    const content = udh ? Buffer.concat([udh, chunk]) : chunk;
    const part: OutboundPart = {
      esm_class: udh ? baseEsm | ESM_CLASS.UDH_INDICATOR : baseEsm,
      data_coding: dataCoding,
    };
    if (strategy === 'payload') part.message_payload = content;
    else part.short_message = content;
    return part;
  };

  // One PDU with message_payload: the SMSC splits it, no concatenation UDH needed.
  if (strategy === 'payload') {
    return {
      dataCoding,
      strategy,
      parts: [build(body, ports ? [ports] : [])],
      udhLength: ports ? ports.data.length + 3 : 0,
    };
  }

  const singleUdh = ports ? ports.data.length + 3 : 0;
  if (body.length <= SM_OCTETS - singleUdh) {
    return { dataCoding, strategy, parts: [build(body, ports ? [ports] : [])], udhLength: singleUdh };
  }

  const concatBytes = strategy === 'udh16' ? 6 : strategy === 'udh8' ? 5 : 0;
  const ieBytes = (ports ? ports.data.length + 2 : 0) + concatBytes;
  const udhLength = ieBytes > 0 ? ieBytes + 1 : 0;
  const capacity = SM_OCTETS - udhLength;
  if (capacity <= 0) {
    throw new SmppValidationError('The UDH leaves no room for content', 'short_message');
  }
  const total = Math.ceil(body.length / capacity);
  if (total > 255) {
    throw new SmppValidationError(
      `Binary message too long (${total} segments, max 255)`,
      'short_message',
      0x00000001,
    );
  }
  const parts = Array.from({ length: total }, (_, idx) => {
    const ies: InformationElement[] = [];
    if (strategy === 'udh8') {
      ies.push({ iei: UDH_IEI.CONCAT_8BIT, data: Buffer.from([options.reference & 0xff, total, idx + 1]) });
    } else if (strategy === 'udh16') {
      const d = Buffer.alloc(4);
      d.writeUInt16BE(options.reference & 0xffff, 0);
      d[2] = total;
      d[3] = idx + 1;
      ies.push({ iei: UDH_IEI.CONCAT_16BIT, data: d });
    }
    if (ports) ies.push(ports);
    const part = build(body.subarray(idx * capacity, (idx + 1) * capacity), ies);
    if (strategy === 'sar') {
      part.sar_msg_ref_num = options.reference & 0xffff;
      part.sar_total_segments = total;
      part.sar_segment_seqnum = idx + 1;
    }
    return part;
  });
  return { dataCoding, strategy, parts, udhLength };
}

// ---------------------------------------------------------------------------
// Decoding incoming messages
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
  /** Body without the UDH (unpacked septets for GSM7). */
  body: Buffer;
  /** Decoded text, or `undefined` for binary content. */
  text?: string;
  udh?: ParsedUdh;
  concat?: ConcatInfo;
  encoding?: string;
}

export interface DecodeContentOptions {
  registry?: EncodingRegistry;
  /** Incoming GSM7 septets are packed. Default: false. */
  packedGsm7?: boolean;
}

/** Extracts the UDH and decodes the text of a deliver_sm / data_sm / submit_sm. */
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
  // BUG-05: GSM handling (septets, fill bits) only applies to GSM encodings.
  if (isGsm && options.packedGsm7) {
    const fill = udh ? (7 - ((udh.length * 8) % 7)) % 7 : 0;
    body = unpackSeptets(raw, undefined, fill + (udh ? udh.length * 8 : 0));
  }
  const result: DecodedContent = { body: Buffer.from(body) };
  if (udh) result.udh = udh;
  if (codec) {
    result.encoding = codec.name;
    result.text = isGsm ? decodeGsm7(body, gsm7TablesOf(udh)) : codec.decode(body);
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
// Reassembly
// ---------------------------------------------------------------------------

export interface ReassemblySegment<T = unknown> {
  source: string;
  destination: string;
  concat: ConcatInfo;
  body: Buffer;
  dataCoding: number;
  shift?: NationalLanguage;
  locking?: NationalLanguage;
  /** Application ports of the segment, when it carries them. */
  ports?: PortInfo;
  /** Free-form attached data (e.g. the original PDU). */
  meta: T;
}

export interface ReassembledMessage<T = unknown> {
  source: string;
  destination: string;
  reference: number;
  total: number;
  /** Full text (or partial, for an expired message), `undefined` if binary. */
  text?: string;
  body: Buffer;
  dataCoding: number;
  /** Received segments, in order. */
  segments: ReassemblySegment<T>[];
  /** Missing segment numbers (partial message only). */
  missing: number[];
  /** Application ports, from the first segment that carries them. */
  ports?: PortInfo;
}

export interface ReassemblerOptions<T> {
  /** Lifetime of an incomplete message. Default: 5 min (SEC-04). */
  ttl?: number;
  /** Maximum number of incomplete messages in memory. Default: 1 000 (SEC-04). */
  maxBuffers?: number;
  /**
   * Maximum number of content octets held by the incomplete messages, all buffers together.
   * Default: 4 MiB. 0 = no limit.
   *
   * `maxBuffers` alone does not bound memory: one buffer holds up to 255 segments, and a segment
   * carried by `message_payload` can be as large as `maxPduLength`. Each held segment also keeps its
   * source PDU, so the real footprint is roughly twice this budget. The oldest buffers are evicted
   * (and reported through `onPartial`) until the total fits.
   */
  maxBytes?: number;
  registry?: EncodingRegistry;
  /** Called when an incomplete message expires or is evicted. */
  onPartial?: (msg: ReassembledMessage<T>) => void;
}

interface Bucket<T> {
  segments: Map<number, ReassemblySegment<T>>;
  total: number;
  /** Content octets held by this bucket's segments. */
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Reassembles segments by (source, destination, reference). Bounded memory. */
export class Reassembler<T = unknown> {
  private readonly buckets = new Map<string, Bucket<T>>();
  private readonly ttl: number;
  private readonly maxBuffers: number;
  private readonly maxBytes: number;
  private readonly registry: EncodingRegistry;
  /** Content octets held by every incomplete message. */
  private heldBytes = 0;

  constructor(private readonly options: ReassemblerOptions<T> = {}) {
    this.ttl = options.ttl ?? 5 * 60_000;
    this.maxBuffers = options.maxBuffers ?? 1000;
    this.maxBytes = Math.max(0, options.maxBytes ?? 4 * 1024 * 1024);
    this.registry = options.registry ?? encodings;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Content octets held by the incomplete messages (SEC-04). */
  get bytes(): number {
    return this.heldBytes;
  }

  /** Adds a segment. Returns the full message once every segment has arrived. */
  add(segment: ReassemblySegment<T>): ReassembledMessage<T> | undefined {
    const { concat } = segment;
    if (concat.total < 1 || concat.sequence < 1 || concat.sequence > concat.total) return undefined;
    const key = `${segment.source}\u0000${segment.destination}\u0000${concat.reference}\u0000${concat.total}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuffers) this.evictOldest();
      const timer = setTimeout(() => this.expire(key), this.ttl);
      timer.unref?.();
      bucket = { segments: new Map(), total: concat.total, bytes: 0, timer };
      this.buckets.set(key, bucket);
    }
    // Duplicate: the last one wins, and only its octets are counted.
    const replaced = bucket.segments.get(concat.sequence);
    if (replaced) this.countBytes(bucket, -replaced.body.length);
    bucket.segments.set(concat.sequence, segment);
    this.countBytes(bucket, segment.body.length);
    if (bucket.segments.size >= bucket.total) {
      clearTimeout(bucket.timer);
      this.buckets.delete(key);
      this.countBytes(bucket, -bucket.bytes);
      return this.assemble(bucket, segment);
    }
    // The newest buffer is kept: evicting it would discard the segment just received.
    this.enforceBudget(key);
    return undefined;
  }

  /** Clears the buffers (without emitting partial messages). */
  clear(): void {
    for (const b of this.buckets.values()) clearTimeout(b.timer);
    this.buckets.clear();
    this.heldBytes = 0;
  }

  private countBytes(bucket: Bucket<T>, delta: number): void {
    bucket.bytes += delta;
    this.heldBytes += delta;
  }

  /** Evicts the oldest buffers until the octet budget is met (`keep` is never evicted). */
  private enforceBudget(keep: string): void {
    if (this.maxBytes === 0) return;
    while (this.heldBytes > this.maxBytes) {
      let victim: string | undefined;
      for (const key of this.buckets.keys()) {
        if (key !== keep) {
          victim = key;
          break;
        }
      }
      if (victim === undefined) return; // only the newest buffer is left
      this.expire(victim);
    }
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
    this.countBytes(bucket, -bucket.bytes);
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
    const ports = segments.find((s) => s.ports)?.ports;
    if (ports) msg.ports = ports;
    if (codec) msg.text = codec.name === 'gsm7' ? decodeGsm7(body, gsm7TablesOf(sample)) : codec.decode(body);
    return msg;
  }
}
