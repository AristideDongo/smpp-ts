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
export class RequestQueue {
  readonly maxSize: number;
  private readonly fairness: number;
  /** One FIFO per priority, index = priority. */
  private lanes: PendingRequest[][] = Array.from({ length: PRIORITY_LEVELS }, () => []);
  private count = 0;
  /** Requests taken in a row from a higher lane while a lower one was waiting. */
  private streak = 0;
  /** Arrival order, to pick the longest-waiting request when the starvation guard fires. */
  private readonly arrival = new WeakMap<PendingRequest, number>();
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
    this.lanes[req.priority]!.push(req);
    this.arrival.set(req, this.ticket++);
    this.count++;
  }

  /** Lane the next request comes from (no side effect: `peek` and `shift` agree). */
  private nextLane(): number | undefined {
    const top = this.topLane();
    if (top === undefined || this.fairness === 0 || this.streak < this.fairness) return top;
    // Starvation guard: the request that has waited longest among the lower priorities.
    let chosen = top;
    let oldest = Number.POSITIVE_INFINITY;
    for (let p = top - 1; p >= 0; p--) {
      const head = this.lanes[p]![0];
      const t = head ? (this.arrival.get(head) ?? 0) : Number.POSITIVE_INFINITY;
      if (t < oldest) {
        oldest = t;
        chosen = p;
      }
    }
    return chosen;
  }

  private topLane(): number | undefined {
    for (let p = PRIORITY_LEVELS - 1; p >= 0; p--) if (this.lanes[p]!.length > 0) return p;
    return undefined;
  }

  peek(): PendingRequest | undefined {
    const lane = this.nextLane();
    return lane === undefined ? undefined : this.lanes[lane]![0];
  }

  shift(): PendingRequest | undefined {
    const top = this.topLane();
    const lane = this.nextLane();
    if (lane === undefined || top === undefined) return undefined;
    const req = this.lanes[lane]!.shift();
    if (!req) return undefined;
    this.count--;
    req.release = undefined;
    if (lane < top) {
      this.streak = 0; // the guard just served a lower priority
    } else {
      const lowerWaiting = this.lanes.some((l, p) => p < lane && l.length > 0);
      this.streak = lowerWaiting ? this.streak + 1 : 0;
    }
    return req;
  }

  remove(req: PendingRequest): void {
    const lane = this.lanes[req.priority]!;
    const i = lane.indexOf(req);
    if (i !== -1) {
      lane.splice(i, 1);
      this.count--;
    }
  }

  /** Rejects every queued request. */
  rejectAll(makeError: (req: PendingRequest) => Error): void {
    const items = this.lanes.flat();
    this.lanes = Array.from({ length: PRIORITY_LEVELS }, () => []);
    this.count = 0;
    this.streak = 0;
    for (const req of items) {
      req.release = undefined;
      req.reject(makeError(req));
    }
  }
}
