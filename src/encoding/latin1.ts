import { SmppValidationError } from '../errors.js';

/** Vrai si chaque caractère est dans ISO-8859-1. */
export function canEncodeLatin1(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return false;
  return true;
}

export function encodeLatin1(text: string): Buffer {
  if (!canEncodeLatin1(text)) {
    throw new SmppValidationError('Text cannot be encoded in Latin-1', 'short_message', 0x00000104);
  }
  return Buffer.from(text, 'latin1');
}

export function decodeLatin1(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1');
}

/** Vrai si chaque caractère est ASCII 7 bits (IA5). */
export function canEncodeAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

export function encodeAscii(text: string): Buffer {
  if (!canEncodeAscii(text)) {
    throw new SmppValidationError('Text cannot be encoded in ASCII', 'short_message', 0x00000104);
  }
  return Buffer.from(text, 'latin1');
}

export function decodeAscii(buf: Uint8Array): string {
  let out = '';
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : '�';
  return out;
}
