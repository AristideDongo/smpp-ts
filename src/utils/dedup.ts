import { createHash } from 'node:crypto';

/**
 * Remembers what was already processed, to drop the copies an SMSC sends again when it did not get
 * a `deliver_sm_resp` (connection lost before the response, response timeout on its side).
 * Called synchronously for every receipt or message: implement it over a shared store (Redis…) with a
 * local cache, or an in-memory set, as `MemoryDedupStore` does.
 */
export interface DedupStore {
  /**
   * Returns `true` when `key` was seen within the last `ttlMs` milliseconds, and records it otherwise
   * (check-and-set in one call).
   */
  seen(key: string, ttlMs: number): boolean;
}

/** In-memory `DedupStore`, bounded: the oldest keys go first beyond `maxEntries`. */
export class MemoryDedupStore implements DedupStore {
  private readonly keys = new Map<string, number>();

  constructor(
    private readonly maxEntries = 100_000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.keys.size;
  }

  seen(key: string, ttlMs: number): boolean {
    const t = this.now();
    const expires = this.keys.get(key);
    if (expires !== undefined && expires > t) return true;
    // Re-inserted at the end: the Map keeps insertion order, oldest first.
    this.keys.delete(key);
    this.keys.set(key, t + ttlMs);
    this.evict(t);
    return false;
  }

  clear(): void {
    this.keys.clear();
  }

  private evict(t: number): void {
    for (const [key, expires] of this.keys) {
      if (this.keys.size <= this.maxEntries && expires > t) break;
      this.keys.delete(key);
    }
  }
}

export interface DedupOptions {
  /**
   * Drops a receipt already received for the same message_id with the same status. On by default:
   * a second identical receipt never carries new information.
   */
  receipts?: boolean;
  /**
   * Drops an incoming message (or segment) identical to one received within `messageTtl`: same sender,
   * recipient, encoding and content. Off by default: a user may really send the same text twice.
   */
  messages?: boolean;
  /** How long a receipt is remembered. Default: 1 hour. */
  ttl?: number;
  /** How long a message is remembered (`messages: true`). Default: 2 minutes. */
  messageTtl?: number;
  /** Maximum keys kept by the default in-memory store. Default: 100 000. */
  maxEntries?: number;
  /** Shared store, e.g. to drop copies that arrive on another process. Default: in memory. */
  store?: DedupStore;
}

/** What a duplicate was (`duplicate` event). */
export type DuplicateKind = 'receipt' | 'message';

/** @internal Applies `DedupOptions` to receipts and messages. */
export class Deduplicator {
  private readonly store: DedupStore;
  readonly receipts: boolean;
  readonly messages: boolean;
  private readonly ttl: number;
  private readonly messageTtl: number;

  constructor(options: DedupOptions = {}) {
    this.store = options.store ?? new MemoryDedupStore(options.maxEntries ?? 100_000);
    this.receipts = options.receipts ?? true;
    this.messages = options.messages ?? false;
    this.ttl = options.ttl ?? 3_600_000;
    this.messageTtl = options.messageTtl ?? 120_000;
  }

  /** `true` if this receipt was already seen. */
  receipt(messageId: string, rawStatus: string, destination: string): boolean {
    if (!this.receipts) return false;
    return this.store.seen(`r\u0000${destination}\u0000${messageId}\u0000${rawStatus}`, this.ttl);
  }

  /** `true` if this message or segment was already seen. `part` identifies a segment (ref/total/seq). */
  message(source: string, destination: string, dataCoding: number, body: Uint8Array, part = ''): boolean {
    if (!this.messages) return false;
    const digest = createHash('sha256').update(body).digest('base64');
    return this.store.seen(
      `m\u0000${source}\u0000${destination}\u0000${dataCoding}\u0000${part}\u0000${digest}`,
      this.messageTtl,
    );
  }

  clear(): void {
    if (this.store instanceof MemoryDedupStore) this.store.clear();
  }
}
