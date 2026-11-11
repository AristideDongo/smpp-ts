/**
 * UCS2 / UTF-16BE avec Buffer natif (pas de dépendance) : `utf16le` + inversion des octets.
 * Les paires de substitution (emoji) sont conservées telles quelles.
 */

export function encodeUcs2(text: string): Buffer {
  return Buffer.from(text, 'utf16le').swap16();
}

/** Décode de l'UTF-16BE. Un octet final orphelin est ignoré. */
export function decodeUcs2(buf: Uint8Array): string {
  const even = buf.length - (buf.length % 2);
  const copy = Buffer.alloc(even);
  copy.set(buf.subarray(0, even));
  return copy.swap16().toString('utf16le');
}

/** Nombre d'unités UTF-16 (un emoji compte pour 2). */
export function ucs2Length(text: string): number {
  return text.length;
}
