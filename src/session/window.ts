import type { Pdu } from '../codec/pdu.js';
import { SmppAbortError, SmppQueueFullError, SmppTimeoutError } from '../errors.js';
import type { CommandName } from '../protocol/commands.js';

export type RequestPhase = 'queued' | 'inflight' | 'done';

/** Pending request: queued, then in flight, until response, error or timeout. */
export interface PendingRequest {
  readonly command: CommandName;
  /** Encoded and validated PDU; the sequence_number is written at send time. */
  readonly encoded: Buffer;
  phase: RequestPhase;
  /** The PDU was written to the socket. */
  written: boolean;
  sequence?: number;
  writtenAt?: number;
  /** Control request (bind, unbind, enquire_link): outside the window and the queue. */
  readonly control: boolean;
  /** Queue priority, 0 (lowest, default) to 3: higher priorities leave the queue first. */
  readonly priority: number;
  readonly timeoutMs: number;
  /** Absolute deadline (epoch ms); `Infinity` without a timeout. */
  readonly deadline: number;
  resolve(pdu: Pdu): void;
  reject(err: Error): void;
  /** Removes the request from whatever holds it (queue or window). */
  release?: () => void;
  /** Cancels the timer. */
  clear(): void;
}

export interface CreateRequestOptions {
  command: CommandName;
  encoded: Buffer;
  timeoutMs: number;
  control?: boolean;
  /** Queue priority, 0 to 3 (clamped). Default: 0. */
  priority?: number | undefined;
  onTimeout?: (req: PendingRequest) => void;
  /** Cancels the request (`SmppAbortError`). */
  signal?: AbortSignal | undefined;
  /** Called after an abort (e.g. to refill the window). */
  onAbort?: (req: PendingRequest) => void;
}

/**
 * Creates a request whose Promise always settles: response, error or timeout (BUG-01).
 * The timer starts at creation: it covers both the queue wait AND the response wait.
 */
export function createPendingRequest(opts: CreateRequestOptions): {
  request: PendingRequest;
  promise: Promise<Pdu>;
} {
  let resolveFn!: (pdu: Pdu) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<Pdu>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = opts.signal;
  const onAbort = () => {
    if (request.phase === 'done') return;
    request.reject(new SmppAbortError(request.written, `${request.command}`, { cause: signal?.reason }));
    opts.onAbort?.(request);
  };

  const request: PendingRequest = {
    command: opts.command,
    encoded: opts.encoded,
    phase: 'queued',
    written: false,
    control: opts.control ?? false,
    priority: clampPriority(opts.priority),
    timeoutMs: opts.timeoutMs,
    deadline:
      opts.timeoutMs > 0 && Number.isFinite(opts.timeoutMs)
        ? Date.now() + opts.timeoutMs
        : Number.POSITIVE_INFINITY,
    resolve(pdu) {
      if (request.phase === 'done') return;
      request.phase = 'done';
      request.clear();
      request.release?.();
      resolveFn(pdu);
    },
    reject(err) {
      if (request.phase === 'done') return;
      request.phase = 'done';
      request.clear();
      request.release?.();
      rejectFn(err);
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
    },
  };

  if (signal?.aborted) {
    // Never queued, never written.
    request.phase = 'done';
    rejectFn(new SmppAbortError(false, `${opts.command}`, { cause: signal.reason }));
    return { request, promise };
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  if (opts.timeoutMs > 0 && Number.isFinite(opts.timeoutMs)) {
    timer = setTimeout(() => expireRequest(request, opts.onTimeout), opts.timeoutMs);
  }
  return { request, promise };
}

/** Rejects an expired request with `SmppTimeoutError`. */
export function expireRequest(request: PendingRequest, onTimeout?: (req: PendingRequest) => void): void {
  if (request.phase === 'done') return;
  const err = new SmppTimeoutError(
    'request',
    request.timeoutMs,
    `${request.command}${request.sequence !== undefined ? ` #${request.sequence}` : ''}`,
    request.written,
  );
  request.reject(err);
  onTimeout?.(request);
}

/** Number of priority levels (same range as `priority_flag`: 0 to 3). */
export const PRIORITY_LEVELS = 4;

/** Clamps a priority to 0..3 (integer). */
export function clampPriority(priority: number | undefined): number {
  if (priority === undefined || !Number.isFinite(priority)) return 0;
  return Math.min(PRIORITY_LEVELS - 1, Math.max(0, Math.trunc(priority)));
}

export interface RequestQueueOptions {
  /** Maximum number of queued requests, all priorities together. Default: 10 000. */
  maxSize?: number;
  /**
   * Starvation guard: after this many requests taken in a row from a higher priority while a lower one
   * waits, one request of the next waiting priority goes out. 0 = strict priority. Default: 10.
   */
  fairness?: number;
}

/**
 * Bounded queue of requests not written yet (REL-03): FIFO within a priority, higher priorities first,
 * with a starvation guard so that bulk traffic still moves while urgent traffic (OTP) flows.
 */
/** FIFO with O(1) push and shift (an array with a moving head, compacted from time to time). */
class Lane {
  private items: Array<PendingRequest | undefined> = [];
  /** Arrival ticket of each item, same index: the starvation guard serves the oldest. */
  private tickets: number[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(req: PendingRequest, ticket: number): void {
    this.items.push(req);
    this.tickets.push(ticket);
  }

  peek(): PendingRequest | undefined {
    return this.items[this.head];
  }

  /** Ticket of the first item, `Infinity` when empty. */
  peekTicket(): number {
    return this.head < this.items.length ? this.tickets[this.head]! : Number.POSITIVE_INFINITY;
  }

  shift(): PendingRequest | undefined {
    if (this.head >= this.items.length) return undefined;
    const req = this.items[this.head];
    this.items[this.head] = undefined;
    this.head++;
    if (this.head === this.items.length) {
      this.items = [];
      this.tickets = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.tickets = this.tickets.slice(this.head);
      this.head = 0;
    }
    return req;
  }

  /** Removes one item (abort or timeout while queued: rare). */
  remove(req: PendingRequest): boolean {
    const i = this.items.indexOf(req, this.head);
    if (i === -1) return false;
    this.items.splice(i, 1);
    this.tickets.splice(i, 1);
    return true;
  }

  drain(): PendingRequest[] {
    const out = this.items.slice(this.head) as PendingRequest[];
    this.items = [];
    this.tickets = [];
    this.head = 0;
    return out;
  }
}

/**
 * Bounded queue of requests not written yet (REL-03): FIFO within a priority, higher priorities first,
 * with a starvation guard so that bulk traffic still moves while urgent traffic (OTP) flows.
 */
export class RequestQueue {
  readonly maxSize: number;
  private readonly fairness: number;
  /** One FIFO per priority, index = priority. */
  private readonly lanes: Lane[] = Array.from({ length: PRIORITY_LEVELS }, () => new Lane());
  private count = 0;
  /** Requests taken in a row from a higher lane while a lower one was waiting. */
  private streak = 0;
  private ticket = 0;

  constructor(options: number | RequestQueueOptions = {}) {
    const o = typeof options === 'number' ? { maxSize: options } : options;
    this.maxSize = o.maxSize ?? 10_000;
    this.fairness = Math.max(0, o.fairness ?? 10);
  }

  get size(): number {
    return this.count;
  }

  /** Queued requests per priority (index = priority). */
  get sizes(): number[] {
    return this.lanes.map((l) => l.length);
  }

  /** Adds a request; rejects it at once with `SmppQueueFullError` if the queue is full. */
  push(req: PendingRequest): void {
    if (req.phase === 'done') return; // already settled (aborted before being queued)
    if (this.count >= this.maxSize) {
      // The request never enters the queue: disarm its timer so no orphan rejection fires.
      req.clear();
      req.phase = 'done';
      throw new SmppQueueFullError(this.maxSize);
    }
    req.phase = 'queued';
    req.release = () => this.remove(req);
    this.lanes[req.priority]!.push(req, this.ticket++);
    this.count++;
  }

  private topLane(): number {
    for (let p = PRIORITY_LEVELS - 1; p >= 0; p--) if (this.lanes[p]!.length > 0) return p;
    return -1;
  }

  /** Lane the next request comes from, -1 when empty (no side effect: `peek` and `shift` agree). */
  private nextLane(top: number): number {
    if (top <= 0 || this.fairness === 0 || this.streak < this.fairness) return top;
    // Starvation guard: the request that has waited longest among the lower priorities.
    let chosen = top;
    let oldest = Number.POSITIVE_INFINITY;
    for (let p = top - 1; p >= 0; p--) {
      const t = this.lanes[p]!.peekTicket();
      if (t < oldest) {
        oldest = t;
        chosen = p;
      }
    }
    return chosen;
  }

  peek(): PendingRequest | undefined {
    const lane = this.nextLane(this.topLane());
    return lane === -1 ? undefined : this.lanes[lane]!.peek();
  }

  shift(): PendingRequest | undefined {
    const top = this.topLane();
    if (top === -1) return undefined;
    const lane = this.nextLane(top);
    const req = this.lanes[lane]!.shift();
    if (!req) return undefined;
    this.count--;
    req.release = undefined;
    if (lane < top) {
      this.streak = 0; // the guard just served a lower priority
    } else if (lane > 0) {
      let lowerWaiting = false;
      for (let p = 0; p < lane; p++) {
        if (this.lanes[p]!.length > 0) {
          lowerWaiting = true;
          break;
        }
      }
      this.streak = lowerWaiting ? this.streak + 1 : 0;
    } else {
      this.streak = 0;
    }
    return req;
  }

  remove(req: PendingRequest): void {
    if (this.lanes[req.priority]!.remove(req)) this.count--;
  }

  /** Rejects every queued request, oldest first. */
  rejectAll(makeError: (req: PendingRequest) => Error): void {
    const items = this.lanes.flatMap((l) => l.drain());
    this.count = 0;
    this.streak = 0;
    for (const req of items) {
      req.release = undefined;
      req.reject(makeError(req));
    }
  }
}
