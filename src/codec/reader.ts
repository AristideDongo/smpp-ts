import { SmppDecodeError } from '../errors.js';
import { COMMAND_STATUS } from '../protocol/status.js';

/**
 * Bounded reader: no read goes past `end`, no string exceeds its maximum length (BUG-06).
 * Any violation throws a `SmppDecodeError` carrying the matching SMPP status.
 */
export class Reader {
  private offset: number;

  constructor(
    private readonly buf: Buffer,
    start = 0,
    private readonly end = buf.length,
  ) {
    this.offset = start;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.end - this.offset;
  }

  private need(n: number, field: string, status: number = COMMAND_STATUS.ESME_RINVCMDLEN): void {
    if (this.offset + n > this.end) {
      throw new SmppDecodeError(
        status,
        `Truncated PDU while reading ${field} (need ${n}, have ${this.remaining})`,
      );
    }
  }

  uint8(field: string): number {
    this.need(1, field);
    return this.buf.readUInt8(this.offset++);
  }

  uint16(field: string): number {
    this.need(2, field);
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  uint32(field: string): number {
    this.need(4, field);
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  /**
   * Reads a C-Octet String. `max` includes the null byte.
   * The search for the null is limited to min(end of PDU, max): never an out-of-bounds read.
   */
  cstring(field: string, max: number, strict = true): string {
    const limit = strict ? Math.min(this.end, this.offset + max) : this.end;
    let i = this.offset;
    while (i < limit && this.buf[i] !== 0) i++;
    if (i >= limit) {
      const overMax = strict && this.offset + max <= this.end;
      throw new SmppDecodeError(
        overMax ? COMMAND_STATUS.ESME_RINVTLVLEN : COMMAND_STATUS.ESME_RINVCMDLEN,
        overMax
          ? `Field ${field} exceeds its maximum length of ${max} octets`
          : `Field ${field} is not NULL-terminated before the end of the PDU`,
      );
    }
    const value = this.buf.toString('latin1', this.offset, i);
    this.offset = i + 1;
    return value;
  }

  /** Reads `n` bytes (copied, so the network buffer is not retained). */
  octets(field: string, n: number, status: number = COMMAND_STATUS.ESME_RINVCMDLEN): Buffer {
    this.need(n, field, status);
    const out = Buffer.from(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return out;
  }
}
