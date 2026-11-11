import type { Pdu } from '../codec/pdu.js';
import { SmppQueueFullError, SmppTimeoutError } from '../errors.js';
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
  onTimeout?: (req: PendingRequest) => void;
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

  const request: PendingRequest = {
    command: opts.command,
    encoded: opts.encoded,
    phase: 'queued',
    written: false,
    control: opts.control ?? false,
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
    },
  };

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

/** Bounded FIFO queue of requests not written yet (REL-03). */
export class RequestQueue {
  private items: PendingRequest[] = [];

  constructor(readonly maxSize = 10_000) {}

  get size(): number {
    return this.items.length;
  }

  /** Adds a request; rejects it at once with `SmppQueueFullError` if the queue is full. */
  push(req: PendingRequest): void {
    if (this.items.length >= this.maxSize) {
      // The request never enters the queue: disarm its timer so no orphan rejection fires.
      req.clear();
      req.phase = 'done';
      throw new SmppQueueFullError(this.maxSize);
    }
    req.phase = 'queued';
    req.release = () => this.remove(req);
    this.items.push(req);
  }

  peek(): PendingRequest | undefined {
    return this.items[0];
  }

  shift(): PendingRequest | undefined {
    const req = this.items.shift();
    if (req) req.release = undefined;
    return req;
  }

  remove(req: PendingRequest): void {
    const i = this.items.indexOf(req);
    if (i !== -1) this.items.splice(i, 1);
  }

  /** Rejects every queued request. */
  rejectAll(makeError: (req: PendingRequest) => Error): void {
    const items = this.items;
    this.items = [];
    for (const req of items) {
      req.release = undefined;
      req.reject(makeError(req));
    }
  }
}
