/**
 * UCS2 / UTF-16BE with native Buffer (no dependency): `utf16le` + byte swap.
 * Surrogate pairs (emoji) are kept as is.
 */

export function encodeUcs2(text: string): Buffer {
  return Buffer.from(text, 'utf16le').swap16();
}

/** Decodes UTF-16BE. A trailing odd byte is ignored. */
export function decodeUcs2(buf: Uint8Array): string {
  const even = buf.length - (buf.length % 2);
  const copy = Buffer.alloc(even);
  copy.set(buf.subarray(0, even));
  return copy.swap16().toString('utf16le');
}

/** Number of UTF-16 code units (an emoji counts as 2). */
export function ucs2Length(text: string): number {
  return text.length;
}
