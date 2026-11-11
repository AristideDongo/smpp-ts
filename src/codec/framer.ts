import { SmppDecodeError } from '../errors.js';
import { HEADER_LENGTH } from '../protocol/constants.js';
import { COMMAND_STATUS } from '../protocol/status.js';
import { DEFAULT_MAX_PDU_LENGTH } from './pdu.js';

export interface FramerResult {
  /** Complete PDUs extracted (each one starts with its command_length). */
  frames: Buffer[];
  /** Fatal error: the stream is out of sync and the session must be closed. */
  error?: SmppDecodeError;
}

/**
 * Splits a TCP stream into PDUs, whatever the fragmentation (REL-08).
 * Pure, no I/O. Never throws: errors are returned in the result.
 */
export class Framer {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private failed = false;

  constructor(private readonly maxPduLength = DEFAULT_MAX_PDU_LENGTH) {}

  /** Bytes received but not yet assembled into a PDU. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Buffer): FramerResult {
    const frames: Buffer[] = [];
    if (this.failed) {
      return {
        frames,
        error: new SmppDecodeError(COMMAND_STATUS.ESME_RINVCMDLEN, 'Stream is desynchronized', {
          fatal: true,
        }),
      };
    }
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }

    while (this.buffered >= 4) {
      const length = this.peekLength();
      if (length < HEADER_LENGTH || length > this.maxPduLength) {
        this.failed = true;
        this.chunks = [];
        this.buffered = 0;
        return {
          frames,
          error: new SmppDecodeError(
            COMMAND_STATUS.ESME_RINVCMDLEN,
            length < HEADER_LENGTH
              ? `Invalid command_length ${length} (min ${HEADER_LENGTH})`
              : `command_length ${length} exceeds maxPduLength ${this.maxPduLength}`,
            { fatal: true },
          ),
        };
      }
      if (this.buffered < length) break;
      frames.push(this.take(length));
    }
    return { frames };
  }

  reset(): void {
    this.chunks = [];
    this.buffered = 0;
    this.failed = false;
  }

  private peekLength(): number {
    const first = this.chunks[0]!;
    if (first.length >= 4) return first.readUInt32BE(0);
    // Length split across several chunks.
    const head = Buffer.alloc(4);
    let copied = 0;
    for (const c of this.chunks) {
      copied += c.copy(head, copied, 0, Math.min(c.length, 4 - copied));
      if (copied === 4) break;
    }
    return head.readUInt32BE(0);
  }

  private take(n: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= n) {
      // Copy: the PDU does not retain the whole network chunk.
      const frame = Buffer.from(first.subarray(0, n));
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return frame;
    }
    const frame = Buffer.allocUnsafe(n);
    let copied = 0;
    while (copied < n) {
      const c = this.chunks[0]!;
      const take = Math.min(c.length, n - copied);
      c.copy(frame, copied, 0, take);
      copied += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.buffered -= n;
    return frame;
  }
}
