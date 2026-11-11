import { SmppError, SmppValidationError } from '../errors.js';
import { DATA_CODING } from '../protocol/constants.js';
import { canEncodeGsm7, decodeGsm7, encodeGsm7 } from './gsm7.js';
import {
  canEncodeAscii,
  canEncodeLatin1,
  decodeAscii,
  decodeLatin1,
  encodeAscii,
  encodeLatin1,
} from './latin1.js';
import { decodeUcs2, encodeUcs2 } from './ucs2.js';

/** Text encoding that can be registered (extensible registry). */
export interface TextCodec {
  /** Unique name (`gsm7`, `latin1`, `ucs2`, `ascii` or operator-specific). */
  readonly name: string;
  /** data_coding value used when sending. */
  readonly dataCoding: number;
  /** Unit size in bits for segment computation (7, 8 or 16). */
  readonly unitBits: 7 | 8 | 16;
  canEncode(text: string): boolean;
  /** Encodes; must throw if the text cannot be represented. */
  encode(text: string): Buffer;
  decode(buf: Uint8Array): string;
  /** Number of units the text takes (septets, octets or UTF-16 code units). */
  length(text: string): number;
}

export const gsm7Codec: TextCodec = {
  name: 'gsm7',
  dataCoding: DATA_CODING.SMSC_DEFAULT,
  unitBits: 7,
  canEncode: (t) => canEncodeGsm7(t),
  encode: (t) => encodeGsm7(t),
  decode: (b) => decodeGsm7(b),
  length: (t) => encodeGsm7(t).length,
};

export const latin1Codec: TextCodec = {
  name: 'latin1',
  dataCoding: DATA_CODING.LATIN1,
  unitBits: 8,
  canEncode: canEncodeLatin1,
  encode: encodeLatin1,
  decode: decodeLatin1,
  length: (t) => t.length,
};

export const ucs2Codec: TextCodec = {
  name: 'ucs2',
  dataCoding: DATA_CODING.UCS2,
  unitBits: 16,
  canEncode: () => true,
  encode: encodeUcs2,
  decode: decodeUcs2,
  length: (t) => t.length,
};

export const asciiCodec: TextCodec = {
  name: 'ascii',
  dataCoding: DATA_CODING.IA5,
  unitBits: 7,
  canEncode: canEncodeAscii,
  encode: encodeAscii,
  decode: decodeAscii,
  length: (t) => t.length,
};

/** Encoding registry and data_coding → encoding mapping. */
export class EncodingRegistry {
  private readonly codecs = new Map<string, TextCodec>();
  private readonly byDataCoding = new Map<number, string>();

  constructor() {
    for (const c of [gsm7Codec, latin1Codec, ucs2Codec, asciiCodec]) this.register(c);
    // 0x00 "SMSC default": GSM7 by default (configurable). 0x01 IA5: GSM7 in practice.
    this.byDataCoding.set(DATA_CODING.SMSC_DEFAULT, 'gsm7');
    this.byDataCoding.set(DATA_CODING.IA5, 'gsm7');
    this.byDataCoding.set(DATA_CODING.LATIN1, 'latin1');
    this.byDataCoding.set(DATA_CODING.UCS2, 'ucs2');
  }

  register(codec: TextCodec, options: { mapDataCoding?: boolean } = {}): this {
    this.codecs.set(codec.name, codec);
    if (options.mapDataCoding) this.byDataCoding.set(codec.dataCoding, codec.name);
    return this;
  }

  /** Maps a data_coding value to an encoding (e.g. `0x00 → 'latin1'` for a given SMSC). */
  mapDataCoding(dataCoding: number, name: string): this {
    if (!this.codecs.has(name)) throw new SmppError('SMPP_CONFIG', `Unknown encoding ${name}`);
    this.byDataCoding.set(dataCoding, name);
    return this;
  }

  get(name: string): TextCodec {
    const c = this.codecs.get(name);
    if (!c) throw new SmppError('SMPP_CONFIG', `Unknown encoding ${name}`);
    return c;
  }

  has(name: string): boolean {
    return this.codecs.has(name);
  }

  /**
   * Encoding matching a data_coding, or `undefined` for binary data.
   * Handles the GSM 03.38 0xF0–0xFF group (message class).
   */
  forDataCoding(dataCoding: number): TextCodec | undefined {
    const name = this.byDataCoding.get(dataCoding);
    if (name) return this.codecs.get(name);
    if ((dataCoding & 0xf0) === 0xf0) {
      return dataCoding & 0x04 ? undefined : this.codecs.get('gsm7');
    }
    // "General data coding" group (00xx xxxx): bits 3-2 = alphabet.
    if ((dataCoding & 0xc0) === 0x00 && dataCoding >= 0x10) {
      const alphabet = (dataCoding >> 2) & 0x03;
      if (alphabet === 0) return this.codecs.get('gsm7');
      if (alphabet === 2) return this.codecs.get('ucs2');
    }
    return undefined;
  }
}

/** Default global registry. */
export const encodings = new EncodingRegistry();

/** Encodes a text for a data_coding (strict: throws if it cannot be represented). */
export function encodeText(text: string, dataCoding: number, registry: EncodingRegistry = encodings): Buffer {
  const codec = registry.forDataCoding(dataCoding);
  if (!codec) {
    throw new SmppValidationError(
      `data_coding 0x${dataCoding.toString(16)} is binary: pass a Buffer instead of a string`,
      'short_message',
    );
  }
  return codec.encode(text);
}

/** Decodes content according to its data_coding. Returns `undefined` for binary content. */
export function decodeText(
  buf: Uint8Array,
  dataCoding: number,
  registry: EncodingRegistry = encodings,
): string | undefined {
  return registry.forDataCoding(dataCoding)?.decode(buf);
}
