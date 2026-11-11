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

/** Encodage de texte enregistrable (registre extensible, §9). */
export interface TextCodec {
  /** Nom unique (`gsm7`, `latin1`, `ucs2`, `ascii` ou propre à un opérateur). */
  readonly name: string;
  /** Valeur data_coding à utiliser à l'envoi. */
  readonly dataCoding: number;
  /** Taille d'une unité en bits pour le calcul des segments (7, 8 ou 16). */
  readonly unitBits: 7 | 8 | 16;
  canEncode(text: string): boolean;
  /** Encode ; doit lever une erreur si le texte n'est pas représentable. */
  encode(text: string): Buffer;
  decode(buf: Uint8Array): string;
  /** Nombre d'unités occupées par le texte (septets, octets ou unités UTF-16). */
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

/** Registre des encodages et correspondance data_coding → encodage. */
export class EncodingRegistry {
  private readonly codecs = new Map<string, TextCodec>();
  private readonly byDataCoding = new Map<number, string>();

  constructor() {
    for (const c of [gsm7Codec, latin1Codec, ucs2Codec, asciiCodec]) this.register(c);
    // 0x00 « défaut SMSC » : GSM7 par défaut (configurable). 0x01 IA5 : GSM7 en pratique.
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

  /** Associe une valeur data_coding à un encodage (ex. `0x00 → 'latin1'` pour un SMSC donné). */
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
   * Encodage correspondant à un data_coding, ou `undefined` pour des données binaires.
   * Gère le groupe 0xF0–0xFF (classe de message) de GSM 03.38.
   */
  forDataCoding(dataCoding: number): TextCodec | undefined {
    const name = this.byDataCoding.get(dataCoding);
    if (name) return this.codecs.get(name);
    if ((dataCoding & 0xf0) === 0xf0) {
      return dataCoding & 0x04 ? undefined : this.codecs.get('gsm7');
    }
    // Groupe « general data coding » (00xx xxxx) : bits 3-2 = alphabet.
    if ((dataCoding & 0xc0) === 0x00 && dataCoding >= 0x10) {
      const alphabet = (dataCoding >> 2) & 0x03;
      if (alphabet === 0) return this.codecs.get('gsm7');
      if (alphabet === 2) return this.codecs.get('ucs2');
    }
    return undefined;
  }
}

/** Registre global par défaut. */
export const encodings = new EncodingRegistry();

/** Encode un texte selon un data_coding (strict : erreur si non représentable). */
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

/** Décode un contenu selon son data_coding. Renvoie `undefined` pour un contenu binaire. */
export function decodeText(
  buf: Uint8Array,
  dataCoding: number,
  registry: EncodingRegistry = encodings,
): string | undefined {
  return registry.forDataCoding(dataCoding)?.decode(buf);
}
