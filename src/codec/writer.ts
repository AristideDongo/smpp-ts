import { SmppValidationError } from '../errors.js';
import { COMMAND_STATUS } from '../protocol/status.js';

/** Growable buffer writer, with strict validation of every value (SEC-03). */
export class Writer {
  private buf: Buffer;
  private offset = 0;

  constructor(initialSize = 256) {
    this.buf = Buffer.allocUnsafe(initialSize);
  }

  get length(): number {
    return this.offset;
  }

  private ensure(n: number): void {
    if (this.offset + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.offset + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.offset);
    this.buf = next;
  }

  private checkInt(field: string, value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
      throw new SmppValidationError(
        `Field ${field} must be an integer between 0 and ${max}`,
        field,
        COMMAND_STATUS.ESME_RSYSERR,
      );
    }
    return value;
  }

  uint8(field: string, value: unknown): void {
    const v = this.checkInt(field, value, 0xff);
    this.ensure(1);
    this.buf.writeUInt8(v, this.offset++);
  }

  uint16(field: string, value: unknown): void {
    const v = this.checkInt(field, value, 0xffff);
    this.ensure(2);
    this.buf.writeUInt16BE(v, this.offset);
    this.offset += 2;
  }

  uint32(field: string, value: unknown): void {
    const v = this.checkInt(field, value, 0xffffffff);
    this.ensure(4);
    this.buf.writeUInt32BE(v, this.offset);
    this.offset += 4;
  }

  /** Writes a C-Octet String. `max` includes the null byte. */
  cstring(field: string, value: unknown, max: number): void {
    if (typeof value !== 'string') {
      throw new SmppValidationError(`Field ${field} must be a string`, field);
    }
    const bytes = Buffer.byteLength(value, 'latin1');
    // Reject characters outside Latin-1 (silent loss) and embedded nulls (truncation).
    if (/[^\x01-\xff]/.test(value)) {
      throw new SmppValidationError(`Field ${field} contains characters that cannot be encoded`, field);
    }
    if (bytes + 1 > max) {
      throw new SmppValidationError(
        `Field ${field} is too long (${bytes} octets, max ${max - 1} + NULL)`,
        field,
        COMMAND_STATUS.ESME_RINVTLVLEN,
      );
    }
    this.ensure(bytes + 1);
    this.buf.write(value, this.offset, 'latin1');
    this.offset += bytes;
    this.buf[this.offset++] = 0;
  }

  octets(value: Uint8Array): void {
    this.ensure(value.length);
    this.buf.set(value, this.offset);
    this.offset += value.length;
  }

  /** Reserves `n` bytes and returns their offset (to write a length afterwards). */
  reserve(n: number): number {
    this.ensure(n);
    const at = this.offset;
    this.offset += n;
    return at;
  }

  patchUint16(at: number, value: number): void {
    this.buf.writeUInt16BE(value, at);
  }

  patchUint32(at: number, value: number): void {
    this.buf.writeUInt32BE(value, at);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.offset));
  }
}
