import { encodeText } from '../encoding/registry.js';
import { SmppDecodeError, SmppError, SmppValidationError } from '../errors.js';
import {
  COMMANDS,
  type CommandName,
  type CommandParams,
  type DestAddress,
  type FieldDefinition,
  type UnsuccessSme,
  commandNameById,
  isResponseCommand,
} from '../protocol/commands.js';
import { HEADER_LENGTH, MAX_SEQUENCE_NUMBER } from '../protocol/constants.js';
import { COMMAND_STATUS } from '../protocol/status.js';
import {
  type NetworkErrorCode,
  TLVS,
  type TlvDefinition,
  type TlvParams,
  type UnknownTlv,
} from '../protocol/tlv.js';
import { Reader } from './reader.js';
import { Writer } from './writer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PduHeader {
  command_length: number;
  command_id: number;
  command_status: number;
  sequence_number: number;
}

interface PduBase<C extends CommandName> {
  command: C;
  command_id: number;
  command_status: number;
  sequence_number: number;
  /** TLVs declared through `customTlvs`, indexed by name. */
  custom_tlvs?: Record<string, unknown>;
  /** Unknown TLVs, kept as is. */
  unknown_tlvs?: UnknownTlv[];
}

/** Decoded PDU of a given command. */
export type PduOf<C extends CommandName> = PduBase<C> & CommandParams<C> & TlvParams;

/** Discriminated union of every PDU (discriminant: `command`). */
export type Pdu = { [C in CommandName]: PduOf<C> }[CommandName];

/** Input parameters of a command: every field is optional (spec defaults apply). */
export type PduParams<C extends CommandName> = Partial<
  Omit<CommandParams<C>, 'short_message'> & {
    short_message: Uint8Array | string;
  }
> &
  TlvParams & {
    custom_tlvs?: Record<string, unknown>;
    unknown_tlvs?: UnknownTlv[];
  };

/** PDU to encode. */
export type PduInput<C extends CommandName = CommandName> = {
  [K in C]: { command: K; sequence_number?: number; command_status?: number } & PduParams<K>;
}[C];

export type DeliverSm = PduOf<'deliver_sm'>;
export type SubmitSm = PduOf<'submit_sm'>;
export type DataSm = PduOf<'data_sm'>;

export interface CustomTlvDefinition extends TlvDefinition {
  name: string;
}

export interface CodecOptions {
  /** Operator-specific TLVs. */
  customTlvs?: CustomTlvDefinition[];
  /**
   * Strict validation when decoding (maximum string and TLV lengths, short_message /
   * message_payload exclusivity). Default: true.
   */
  strict?: boolean;
  /** Maximum PDU size (SEC-04). Default: 16 384 bytes. */
  maxPduLength?: number;
}

export const DEFAULT_MAX_PDU_LENGTH = 16_384;

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

/** Standard TLVs in table order, and the position of each name: TLVs are written in this order. */
const STANDARD_TLV_LIST = Object.entries(TLVS) as [string, TlvDefinition][];
const STANDARD_TLV_INDEX = new Map<string, number>(STANDARD_TLV_LIST.map(([name], i) => [name, i]));

const STANDARD_TLVS_BY_TAG = new Map<number, [string, TlvDefinition]>(
  (Object.entries(TLVS) as [string, TlvDefinition][]).map(([name, def]) => [def.tag, [name, def]]),
);

/** PDU ⇄ bytes codec. Pure: no I/O. */
export class PduCodec {
  readonly strict: boolean;
  readonly maxPduLength: number;
  private readonly customByTag = new Map<number, CustomTlvDefinition>();
  private readonly customByName = new Map<string, CustomTlvDefinition>();

  constructor(options: CodecOptions = {}) {
    this.strict = options.strict ?? true;
    this.maxPduLength = options.maxPduLength ?? DEFAULT_MAX_PDU_LENGTH;
    for (const def of options.customTlvs ?? []) {
      if (STANDARD_TLVS_BY_TAG.has(def.tag) || this.customByTag.has(def.tag)) {
        throw new SmppError('SMPP_CONFIG', `Duplicate TLV tag 0x${def.tag.toString(16)} (${def.name})`);
      }
      if (def.name in TLVS) {
        throw new SmppError('SMPP_CONFIG', `Custom TLV name ${def.name} collides with a standard TLV`);
      }
      this.customByTag.set(def.tag, def);
      this.customByName.set(def.name, def);
    }
  }

  // ------------------------------------------------------------------ encode

  encode(input: PduInput): Buffer {
    const command = input.command;
    const def = (COMMANDS as Record<string, { id: number; params: readonly FieldDefinition[] }>)[command];
    if (!def) throw new SmppValidationError(`Unknown command ${String(command)}`, 'command');

    const seq = input.sequence_number ?? 1;
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQUENCE_NUMBER) {
      throw new SmppValidationError('sequence_number must be between 0 and 0x7FFFFFFF', 'sequence_number');
    }

    const params = input as unknown as AnyRecord;
    const w = new Writer();
    w.reserve(4); // command_length
    w.uint32('command_id', def.id);
    w.uint32('command_status', input.command_status ?? 0);
    w.uint32('sequence_number', seq);

    for (const field of def.params) {
      this.encodeField(w, field, params);
    }
    this.checkExclusivity(params, true);
    this.encodeTlvs(w, params);

    if (w.length > this.maxPduLength) {
      throw new SmppValidationError(
        `PDU too long (${w.length} octets, max ${this.maxPduLength})`,
        undefined,
        COMMAND_STATUS.ESME_RINVMSGLEN,
      );
    }
    w.patchUint32(0, w.length);
    return w.toBuffer();
  }

  private encodeField(w: Writer, field: FieldDefinition, params: AnyRecord): void {
    const value = params[field.name];
    switch (field.type) {
      case 'uint8':
        w.uint8(field.name, value ?? 0);
        return;
      case 'uint16':
        w.uint16(field.name, value ?? 0);
        return;
      case 'uint32':
        w.uint32(field.name, value ?? 0);
        return;
      case 'cstring':
        w.cstring(field.name, value ?? '', field.max ?? 256);
        return;
      case 'sm_length':
        return; // written together with short_message
      case 'short_message': {
        const bytes = toShortMessageBytes(value, params.data_coding);
        if (bytes.length > (field.max ?? 255)) {
          throw new SmppValidationError(
            `short_message is too long (${bytes.length} octets, max 255); use message_payload or split the message`,
            'short_message',
            COMMAND_STATUS.ESME_RINVMSGLEN,
          );
        }
        if (params.sm_length !== undefined && params.sm_length !== bytes.length) {
          throw new SmppValidationError(
            `sm_length (${String(params.sm_length)}) does not match short_message length (${bytes.length})`,
            'sm_length',
            COMMAND_STATUS.ESME_RINVMSGLEN,
          );
        }
        w.uint8('sm_length', bytes.length);
        w.octets(bytes);
        return;
      }
      case 'dest_address_list':
        encodeDestAddresses(w, value);
        return;
      case 'unsuccess_sme_list':
        encodeUnsuccessSmes(w, value);
        return;
    }
  }

  private checkExclusivity(params: AnyRecord, encoding: boolean): void {
    const sm = params.short_message;
    const smLen = sm === undefined ? 0 : typeof sm === 'string' ? sm.length : (sm as Uint8Array).length;
    if (smLen > 0 && params.message_payload !== undefined) {
      const msg = 'short_message and message_payload are mutually exclusive';
      if (encoding) throw new SmppValidationError(msg, 'message_payload', COMMAND_STATUS.ESME_RINVTLVVAL);
      throw new SmppDecodeError(COMMAND_STATUS.ESME_RINVTLVVAL, msg);
    }
  }

  private encodeTlvs(w: Writer, params: AnyRecord): void {
    // Only the parameters actually given are looked at (a PDU carries a handful of keys, the table has
    // about a hundred TLVs), then written in table order, as before.
    let present: number[] | undefined;
    for (const key in params) {
      const index = STANDARD_TLV_INDEX.get(key);
      if (index === undefined || params[key] === undefined) continue;
      if (present === undefined) present = [index];
      else present.push(index);
    }
    if (present) {
      if (present.length > 1) present.sort((a, b) => a - b);
      for (const index of present) {
        const [name, def] = STANDARD_TLV_LIST[index]!;
        this.encodeTlvValues(w, name, def, params[name]);
      }
    }
    const custom = params.custom_tlvs as AnyRecord | undefined;
    if (custom) {
      for (const [name, value] of Object.entries(custom)) {
        if (value === undefined) continue;
        const def = this.customByName.get(name);
        if (!def) throw new SmppValidationError(`Unknown custom TLV ${name}`, name);
        this.encodeTlvValues(w, name, def, value);
      }
    }
    const unknown = params.unknown_tlvs as UnknownTlv[] | undefined;
    for (const tlv of unknown ?? []) {
      writeTlvHeader(w, 'unknown_tlvs', tlv.tag, tlv.value.length);
      w.octets(tlv.value);
    }
  }

  private encodeTlvValues(w: Writer, name: string, def: TlvDefinition, value: unknown): void {
    if (def.multiple) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) encodeTlv(w, name, def, v);
    } else {
      encodeTlv(w, name, def, value);
    }
  }

  // ------------------------------------------------------------------ decode

  /** Reads the header (16 bytes) without validating the body. */
  readHeader(buf: Buffer): PduHeader {
    if (buf.length < HEADER_LENGTH) {
      throw new SmppDecodeError(COMMAND_STATUS.ESME_RINVCMDLEN, 'PDU shorter than its header', {
        fatal: true,
      });
    }
    return {
      command_length: buf.readUInt32BE(0),
      command_id: buf.readUInt32BE(4),
      command_status: buf.readUInt32BE(8),
      sequence_number: buf.readUInt32BE(12),
    };
  }

  /**
   * Decodes a full PDU (as delivered by the `Framer`).
   * Only throws `SmppDecodeError`, never any other exception.
   */
  decode(buf: Buffer): Pdu {
    const header = this.readHeader(buf);
    const hdr = {
      command_id: header.command_id,
      command_status: header.command_status,
      sequence_number: header.sequence_number,
    };
    if (header.command_length !== buf.length) {
      throw new SmppDecodeError(
        COMMAND_STATUS.ESME_RINVCMDLEN,
        'command_length does not match the PDU size',
        {
          header: hdr,
        },
      );
    }
    const command = commandNameById(header.command_id);
    if (!command) {
      throw new SmppDecodeError(
        COMMAND_STATUS.ESME_RINVCMDID,
        `Unknown command_id 0x${header.command_id.toString(16).padStart(8, '0')}`,
        { header: hdr },
      );
    }

    try {
      return this.decodeBody(buf, command, hdr);
    } catch (err) {
      if (err instanceof SmppDecodeError) {
        throw new SmppDecodeError(err.status, `${command}: ${err.message}`, { header: hdr, cause: err });
      }
      // Safety net: the parser must never let anything else escape.
      throw new SmppDecodeError(COMMAND_STATUS.ESME_RSYSERR, `${command}: unexpected decode failure`, {
        header: hdr,
        cause: err,
      });
    }
  }

  private decodeBody(
    buf: Buffer,
    command: CommandName,
    hdr: { command_id: number; command_status: number; sequence_number: number },
  ): Pdu {
    const def = COMMANDS[command] as { id: number; params: readonly FieldDefinition[] };
    const r = new Reader(buf, HEADER_LENGTH, buf.length);
    const out: AnyRecord = { command, ...hdr };
    const lenient = isResponseCommand(command);

    let smLength = 0;
    for (const field of def.params) {
      // Responses: some SMSCs omit the body (especially on errors). Fill in the defaults.
      if (lenient && r.remaining === 0) {
        out[field.name] = defaultValue(field);
        continue;
      }
      switch (field.type) {
        case 'uint8':
          out[field.name] = r.uint8(field.name);
          break;
        case 'uint16':
          out[field.name] = r.uint16(field.name);
          break;
        case 'uint32':
          out[field.name] = r.uint32(field.name);
          break;
        case 'cstring':
          out[field.name] = r.cstring(field.name, field.max ?? 256, this.strict);
          break;
        case 'sm_length':
          smLength = r.uint8('sm_length');
          out.sm_length = smLength;
          break;
        case 'short_message':
          out.short_message = r.octets('short_message', smLength, COMMAND_STATUS.ESME_RINVMSGLEN);
          break;
        case 'dest_address_list':
          out[field.name] = this.decodeDestAddresses(r);
          break;
        case 'unsuccess_sme_list':
          out[field.name] = this.decodeUnsuccessSmes(r);
          break;
      }
    }

    this.decodeTlvs(r, out);
    if (this.strict) this.checkExclusivity(out, false);
    return out as unknown as Pdu;
  }

  private decodeDestAddresses(r: Reader): DestAddress[] {
    const count = r.uint8('number_of_dests');
    const list: DestAddress[] = [];
    for (let i = 0; i < count; i++) {
      const flag = r.uint8('dest_flag');
      if (flag === 1) {
        list.push({
          dest_flag: 1,
          dest_addr_ton: r.uint8('dest_addr_ton'),
          dest_addr_npi: r.uint8('dest_addr_npi'),
          destination_addr: r.cstring('destination_addr', 21, this.strict),
        });
      } else if (flag === 2) {
        list.push({ dest_flag: 2, dl_name: r.cstring('dl_name', 21, this.strict) });
      } else {
        throw new SmppDecodeError(COMMAND_STATUS.ESME_RINVDESTFLAG, `Invalid dest_flag ${flag}`);
      }
    }
    return list;
  }

  private decodeUnsuccessSmes(r: Reader): UnsuccessSme[] {
    const count = r.uint8('no_unsuccess');
    const list: UnsuccessSme[] = [];
    for (let i = 0; i < count; i++) {
      list.push({
        dest_addr_ton: r.uint8('dest_addr_ton'),
        dest_addr_npi: r.uint8('dest_addr_npi'),
        destination_addr: r.cstring('destination_addr', 21, this.strict),
        error_status_code: r.uint32('error_status_code'),
      });
    }
    return list;
  }

  private decodeTlvs(r: Reader, out: AnyRecord): void {
    while (r.remaining > 0) {
      if (r.remaining < 4) {
        throw new SmppDecodeError(COMMAND_STATUS.ESME_RINVTLVSTREAM, 'Truncated TLV header');
      }
      const tag = r.uint16('tlv.tag');
      const len = r.uint16('tlv.length');
      if (len > r.remaining) {
        throw new SmppDecodeError(
          COMMAND_STATUS.ESME_RINVTLVLEN,
          `TLV 0x${tag.toString(16)} length ${len} exceeds the remaining ${r.remaining} octets`,
        );
      }
      const raw = r.octets('tlv.value', len);
      const standard = STANDARD_TLVS_BY_TAG.get(tag);
      if (standard) {
        const [name, def] = standard;
        assign(out, name, decodeTlvValue(name, def, raw, this.strict), def.multiple);
        continue;
      }
      const custom = this.customByTag.get(tag);
      if (custom) {
        if (!out.custom_tlvs) out.custom_tlvs = {};
        const bag = out.custom_tlvs as AnyRecord;
        assign(bag, custom.name, decodeTlvValue(custom.name, custom, raw, this.strict), custom.multiple);
        continue;
      }
      if (!out.unknown_tlvs) out.unknown_tlvs = [];
      (out.unknown_tlvs as UnknownTlv[]).push({ tag, value: raw });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultValue(field: FieldDefinition): unknown {
  switch (field.type) {
    case 'cstring':
      return '';
    case 'short_message':
      return Buffer.alloc(0);
    case 'dest_address_list':
    case 'unsuccess_sme_list':
      return [];
    default:
      return 0;
  }
}

function assign(target: AnyRecord, name: string, value: unknown, multiple?: boolean): void {
  if (multiple) {
    if (!Array.isArray(target[name])) target[name] = [];
    (target[name] as unknown[]).push(value);
  } else {
    target[name] = value;
  }
}

function toShortMessageBytes(value: unknown, dataCoding: unknown): Uint8Array {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    return encodeText(value, typeof dataCoding === 'number' ? dataCoding : 0);
  }
  throw new SmppValidationError('short_message must be a Buffer, Uint8Array or string', 'short_message');
}

function encodeDestAddresses(w: Writer, value: unknown): void {
  const list = (value ?? []) as DestAddress[];
  if (!Array.isArray(list) || list.length < 1 || list.length > 255) {
    throw new SmppValidationError(
      'dest_address must contain between 1 and 255 destinations',
      'dest_address',
      COMMAND_STATUS.ESME_RINVNUMDESTS,
    );
  }
  w.uint8('number_of_dests', list.length);
  for (const d of list) {
    if (d.dest_flag === 1) {
      w.uint8('dest_flag', 1);
      w.uint8('dest_addr_ton', d.dest_addr_ton ?? 0);
      w.uint8('dest_addr_npi', d.dest_addr_npi ?? 0);
      w.cstring('destination_addr', d.destination_addr, 21);
    } else if (d.dest_flag === 2) {
      w.uint8('dest_flag', 2);
      w.cstring('dl_name', d.dl_name, 21);
    } else {
      throw new SmppValidationError(
        'dest_flag must be 1 or 2',
        'dest_flag',
        COMMAND_STATUS.ESME_RINVDESTFLAG,
      );
    }
  }
}

function encodeUnsuccessSmes(w: Writer, value: unknown): void {
  const list = (value ?? []) as UnsuccessSme[];
  if (!Array.isArray(list) || list.length > 255) {
    throw new SmppValidationError('unsuccess_sme must contain at most 255 entries', 'unsuccess_sme');
  }
  w.uint8('no_unsuccess', list.length);
  for (const u of list) {
    w.uint8('dest_addr_ton', u.dest_addr_ton ?? 0);
    w.uint8('dest_addr_npi', u.dest_addr_npi ?? 0);
    w.cstring('destination_addr', u.destination_addr, 21);
    w.uint32('error_status_code', u.error_status_code ?? 0);
  }
}

function writeTlvHeader(w: Writer, name: string, tag: number, length: number): void {
  if (length > 0xffff) {
    throw new SmppValidationError(`TLV ${name} is too long`, name, COMMAND_STATUS.ESME_RINVTLVLEN);
  }
  w.uint16(`${name}.tag`, tag);
  w.uint16(`${name}.length`, length);
}

function checkTlvLength(name: string, def: TlvDefinition, length: number): void {
  if ((def.min !== undefined && length < def.min) || (def.max !== undefined && length > def.max)) {
    throw new SmppValidationError(
      `TLV ${name} has an invalid length (${length}, expected ${def.min ?? 0}..${def.max ?? 65535})`,
      name,
      COMMAND_STATUS.ESME_RINVTLVLEN,
    );
  }
}

const UINT_SIZES = { uint8: 1, uint16: 2, uint32: 4 } as const;

function encodeTlv(w: Writer, name: string, def: TlvDefinition, value: unknown): void {
  switch (def.type) {
    case 'uint8':
    case 'uint16':
    case 'uint32': {
      writeTlvHeader(w, name, def.tag, UINT_SIZES[def.type]);
      w[def.type](name, value);
      return;
    }
    case 'cstring': {
      if (typeof value !== 'string') throw new SmppValidationError(`TLV ${name} must be a string`, name);
      const len = Buffer.byteLength(value, 'latin1') + 1;
      if (def.max !== undefined && len > def.max) {
        throw new SmppValidationError(`TLV ${name} is too long`, name, COMMAND_STATUS.ESME_RINVTLVLEN);
      }
      writeTlvHeader(w, name, def.tag, len);
      w.cstring(name, value, len);
      return;
    }
    case 'octets': {
      if (!(value instanceof Uint8Array)) {
        throw new SmppValidationError(`TLV ${name} must be a Buffer or Uint8Array`, name);
      }
      checkTlvLength(name, def, value.length);
      writeTlvHeader(w, name, def.tag, value.length);
      w.octets(value);
      return;
    }
    case 'network_error': {
      const v = value as NetworkErrorCode;
      if (!v || typeof v !== 'object') {
        throw new SmppValidationError(`TLV ${name} must be { network_type, error_code }`, name);
      }
      writeTlvHeader(w, name, def.tag, 3);
      w.uint8(`${name}.network_type`, v.network_type);
      w.uint16(`${name}.error_code`, v.error_code);
      return;
    }
    case 'flag': {
      if (value === true) {
        writeTlvHeader(w, name, def.tag, 0);
      } else {
        writeTlvHeader(w, name, def.tag, 1);
        w.uint8(name, value);
      }
      return;
    }
  }
}

function decodeTlvValue(name: string, def: TlvDefinition, raw: Buffer, strict: boolean): unknown {
  const fail = (msg: string) => new SmppDecodeError(COMMAND_STATUS.ESME_RINVTLVLEN, `TLV ${name}: ${msg}`);
  switch (def.type) {
    case 'uint8':
    case 'uint16':
    case 'uint32': {
      const size = UINT_SIZES[def.type];
      if (raw.length !== size) {
        if (strict || raw.length === 0 || raw.length > 4)
          throw fail(`expected ${size} octets, got ${raw.length}`);
      }
      return raw.readUIntBE(0, raw.length);
    }
    case 'cstring': {
      if (def.max !== undefined && raw.length > def.max && strict) throw fail('too long');
      const nul = raw.indexOf(0);
      return raw.toString('latin1', 0, nul === -1 ? raw.length : nul);
    }
    case 'octets':
      if (
        strict &&
        ((def.min !== undefined && raw.length < def.min) || (def.max !== undefined && raw.length > def.max))
      ) {
        throw fail(`invalid length ${raw.length}`);
      }
      return raw;
    case 'network_error':
      if (raw.length !== 3) throw fail(`expected 3 octets, got ${raw.length}`);
      return { network_type: raw.readUInt8(0), error_code: raw.readUInt16BE(1) } satisfies NetworkErrorCode;
    case 'flag':
      if (raw.length === 0) return true;
      if (raw.length === 1) return raw.readUInt8(0);
      throw fail(`expected 0 or 1 octet, got ${raw.length}`);
  }
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

export const defaultCodec: PduCodec = new PduCodec();

/** Encodes a PDU with the default codec. */
export function encodePdu(input: PduInput): Buffer {
  return defaultCodec.encode(input);
}

/** Decodes a full PDU with the default codec. */
export function decodePdu(buf: Buffer): Pdu {
  return defaultCodec.decode(buf);
}

/** Narrows a PDU to a command (type guard). */
export function isCommand<C extends CommandName>(pdu: Pdu, command: C): pdu is Extract<Pdu, { command: C }> {
  return pdu.command === command;
}
