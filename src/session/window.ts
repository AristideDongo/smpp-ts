import type { Pdu } from '../codec/pdu.js';
import { SmppQueueFullError, SmppTimeoutError } from '../errors.js';
import type { CommandName } from '../protocol/commands.js';

export type RequestPhase = 'queued' | 'inflight' | 'done';

/** Requête en attente : dans la file, puis en vol, jusqu'à réponse, erreur ou timeout. */
export interface PendingRequest {
  readonly command: CommandName;
  /** PDU encodé et validé ; le sequence_number est inscrit au moment de l'envoi. */
  readonly encoded: Buffer;
  phase: RequestPhase;
  /** Le PDU a été écrit sur le socket. */
  written: boolean;
  sequence?: number;
  writtenAt?: number;
  /** Requête de contrôle (bind, unbind, enquire_link) : hors fenêtre et hors file. */
  readonly control: boolean;
  readonly timeoutMs: number;
  /** Échéance absolue (ms epoch) ; `Infinity` sans timeout. */
  readonly deadline: number;
  resolve(pdu: Pdu): void;
  reject(err: Error): void;
  /** Retire la requête de la structure qui la détient (file ou fenêtre). */
  release?: () => void;
  /** Annule le timer. */
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
 * Crée une requête dont la Promise aboutit toujours : réponse, erreur ou timeout (BUG-01).
 * Le timer démarre à la création : il couvre l'attente en file ET l'attente de réponse.
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

/** Rejette une requête arrivée à échéance avec `SmppTimeoutError`. */
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

/** File FIFO bornée des requêtes pas encore écrites (REL-03). */
export class RequestQueue {
  private items: PendingRequest[] = [];

  constructor(readonly maxSize = 10_000) {}

  get size(): number {
    return this.items.length;
  }

  /** Ajoute une requête ; rejette immédiatement avec `SmppQueueFullError` si la file est pleine. */
  push(req: PendingRequest): void {
    if (this.items.length >= this.maxSize) {
      // La requête n'entre jamais dans la file : on désarme son timer pour qu'aucun rejet orphelin ne survienne.
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

  /** Rejette toutes les requêtes en file. */
  rejectAll(makeError: (req: PendingRequest) => Error): void {
    const items = this.items;
    this.items = [];
    for (const req of items) {
      req.release = undefined;
      req.reject(makeError(req));
    }
  }
}
