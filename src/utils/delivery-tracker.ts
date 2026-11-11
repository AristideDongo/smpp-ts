import type { DeliveryReport, DlrStatus } from './dlr.js';

/**
 * Aggregated outcome of a (possibly multi-segment) message:
 * - `DELIVERED`: every segment was delivered;
 * - `FAILED`: no segment was delivered;
 * - `PARTIALLY_DELIVERED`: only some segments were;
 * - `TIMEOUT`: not every final receipt arrived within `ttl`, or tracking was evicted.
 */
export type MessageOutcome = 'DELIVERED' | 'FAILED' | 'PARTIALLY_DELIVERED' | 'TIMEOUT';

export interface MessageStatus {
  outcome: MessageOutcome;
  /** `message_id` of each segment, in sending order. */
  messageIds: string[];
  parts: number;
  /** Final receipt of each segment (same index as `messageIds`), `undefined` if it never arrived. */
  reports: Array<DeliveryReport | undefined>;
  /** Application reference passed to `track()` / `sendText({ reference })`. */
  reference?: string;
  /** Time of the first `track()`. */
  submittedAt: Date;
}

export interface DeliveryTrackerOptions {
  /** Maximum wait for the final receipts. Default: 24 h. */
  ttl?: number;
  /** Maximum tracked messages; beyond that, the oldest is closed as `TIMEOUT`. Default: 100 000. */
  maxTracked?: number;
  /**
   * How long a receipt that arrives before its `submit_sm_resp` is kept
   * (possible for the segments of a long message). Default: 60 s.
   */
  orphanTtl?: number;
  /** Maximum number of orphan receipts kept. Default: 10 000. */
  maxOrphans?: number;
  /**
   * Persistence of tracked messages, so that tracking survives a restart. Every change is written
   * through to the store; `restore()` reloads it. Without a store, tracking is in memory only.
   */
  store?: DeliveryTrackerStore;
  /** Called when the store fails (the tracker keeps working in memory). */
  onStoreError?: (error: unknown) => void;
}

/**
 * A tracked message, as written to a `DeliveryTrackerStore`.
 * Plain data: `JSON.stringify` works (dates in reports come back as strings and are revived by `restore()`).
 */
export interface TrackedMessageRecord {
  /** Stable key: the first `message_id`. */
  key: string;
  messageIds: string[];
  /** Final receipt of each segment, `null` while it has not arrived. */
  reports: Array<DeliveryReport | null>;
  reference?: string;
  /** Epoch ms. */
  submittedAt: number;
  /** Epoch ms after which the message is closed as `TIMEOUT`. */
  expiresAt: number;
}

/**
 * Where the tracker persists messages awaiting receipts (Redis, SQL, a file…).
 * Implemented by the application: the library ships no storage. Methods may be synchronous or async.
 */
export interface DeliveryTrackerStore {
  /** Creates or replaces a record (on `track()` and on each final receipt). */
  save(record: TrackedMessageRecord): void | Promise<void>;
  /** Removes a record once its outcome has been reported. */
  delete(key: string): void | Promise<void>;
  /** Every record still stored (called by `restore()`). */
  load(): Iterable<TrackedMessageRecord> | Promise<Iterable<TrackedMessageRecord>>;
}

/** Statuses that will not change any more: the receipt is final. */
const FINAL_STATUSES = new Set<DlrStatus>([
  'DELIVERED',
  'EXPIRED',
  'DELETED',
  'UNDELIVERABLE',
  'REJECTED',
  'UNKNOWN',
  'SKIPPED',
]);

export function isFinalDlrStatus(status: DlrStatus): boolean {
  return FINAL_STATUSES.has(status);
}

interface Entry {
  key: string;
  expiresAt: number;
  messageIds: string[];
  reports: Array<DeliveryReport | undefined>;
  remaining: number;
  reference: string | undefined;
  submittedAt: Date;
  timer: ReturnType<typeof setTimeout>;
}

interface Orphan {
  dlr: DeliveryReport;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Groups the delivery receipts of the segments of one message and reports
 * its outcome once every final receipt has arrived (or when `ttl` expires).
 *
 * Bounded memory (`maxTracked`, `maxOrphans`). Optional persistence through a `DeliveryTrackerStore`:
 * call `restore()` at startup to resume tracking after a restart.
 */
export class DeliveryTracker {
  private readonly entries = new Map<Entry, true>();
  private readonly byId = new Map<string, { entry: Entry; index: number }>();
  private readonly orphans = new Map<string, Orphan>();
  private readonly ttl: number;
  private readonly maxTracked: number;
  private readonly orphanTtl: number;
  private readonly maxOrphans: number;
  private readonly store: DeliveryTrackerStore | undefined;
  private readonly onStoreError: (error: unknown) => void;
  private restored: Promise<number> | undefined;

  constructor(
    private readonly onStatus: (status: MessageStatus) => void,
    options: DeliveryTrackerOptions = {},
  ) {
    this.ttl = options.ttl ?? 24 * 60 * 60 * 1000;
    this.maxTracked = options.maxTracked ?? 100_000;
    this.orphanTtl = options.orphanTtl ?? 60_000;
    this.maxOrphans = options.maxOrphans ?? 10_000;
    this.store = options.store;
    this.onStoreError = options.onStoreError ?? (() => {});
  }

  /** Messages awaiting receipts. */
  get size(): number {
    return this.entries.size;
  }

  /** Starts tracking a message from the `message_id` of its segments. */
  track(messageIds: readonly string[], reference?: string): void {
    if (messageIds.length === 0) return;
    const ids = messageIds.map((id) => id.trim());
    const now = Date.now();
    const entry = this.addEntry({
      key: ids[0]!,
      messageIds: ids,
      reports: new Array(ids.length).fill(null),
      ...(reference !== undefined ? { reference } : {}),
      submittedAt: now,
      expiresAt: now + this.ttl,
    });
    this.persist(entry);

    for (const id of entry.messageIds) {
      const orphan = this.orphans.get(id);
      if (!orphan) continue;
      clearTimeout(orphan.timer);
      this.orphans.delete(id);
      if (!this.entries.has(entry)) return; // already closed by an earlier orphan
      this.handle(orphan.dlr);
    }
  }

  /**
   * Handles a receipt. Returns `true` if it matches a tracked message.
   * An unmatched final receipt is kept `orphanTtl` ms in case `track()` comes later.
   */
  handle(dlr: DeliveryReport): boolean {
    const match = this.byId.get(dlr.messageId) ?? this.byId.get(dlr.rawMessageId.trim());
    if (!match) {
      if (isFinalDlrStatus(dlr.status)) this.keepOrphan(dlr);
      return false;
    }
    if (!isFinalDlrStatus(dlr.status)) return true;
    const { entry, index } = match;
    if (entry.reports[index] === undefined) entry.remaining--;
    entry.reports[index] = dlr;
    if (entry.remaining > 0) this.persist(entry);
    if (entry.remaining === 0) {
      const delivered = entry.reports.filter((r) => r?.status === 'DELIVERED').length;
      this.finish(
        entry,
        delivered === entry.reports.length ? 'DELIVERED' : delivered === 0 ? 'FAILED' : 'PARTIALLY_DELIVERED',
      );
    }
    return true;
  }

  /**
   * Reloads the messages saved in the store (call it once at startup, before receipts arrive).
   * Messages whose `ttl` has passed are closed as `TIMEOUT` at once. Returns the number of messages
   * tracked again. Without a store: 0.
   */
  restore(): Promise<number> {
    this.restored ??= this.load();
    return this.restored;
  }

  private async load(): Promise<number> {
    if (!this.store) return 0;
    let records: Iterable<TrackedMessageRecord>;
    try {
      records = await this.store.load();
    } catch (err) {
      this.onStoreError(err);
      return 0;
    }
    let count = 0;
    for (const record of records) {
      if (this.byId.has(record.messageIds[0] ?? '')) continue; // already tracked in this process
      const entry = this.addEntry({ ...record, reports: record.reports.map(reviveReport) });
      if (this.entries.has(entry)) count++;
    }
    return count;
  }

  /** Drops all tracking in progress, without emitting any status. */
  clear(): void {
    for (const entry of this.entries.keys()) clearTimeout(entry.timer);
    for (const orphan of this.orphans.values()) clearTimeout(orphan.timer);
    this.entries.clear();
    this.byId.clear();
    this.orphans.clear();
  }

  private addEntry(record: TrackedMessageRecord): Entry {
    while (this.entries.size >= this.maxTracked) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.finish(oldest, 'TIMEOUT');
    }
    const reports = record.reports.map((r) => r ?? undefined);
    const entry: Entry = {
      key: record.key,
      expiresAt: record.expiresAt,
      messageIds: record.messageIds,
      reports,
      remaining: reports.filter((r) => r === undefined).length,
      reference: record.reference,
      submittedAt: new Date(record.submittedAt),
      timer: setTimeout(() => this.finish(entry, 'TIMEOUT'), Math.max(0, record.expiresAt - Date.now())),
    };
    entry.timer.unref?.();
    this.entries.set(entry, true);
    entry.messageIds.forEach((id, index) => this.byId.set(id, { entry, index }));
    return entry;
  }

  private persist(entry: Entry): void {
    if (!this.store) return;
    const record: TrackedMessageRecord = {
      key: entry.key,
      messageIds: entry.messageIds,
      reports: entry.reports.map((r) => r ?? null),
      submittedAt: entry.submittedAt.getTime(),
      expiresAt: entry.expiresAt,
    };
    if (entry.reference !== undefined) record.reference = entry.reference;
    this.storeCall(() => this.store!.save(record));
  }

  private storeCall(fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(this.onStoreError);
      }
    } catch (err) {
      this.onStoreError(err);
    }
  }

  private keepOrphan(dlr: DeliveryReport): void {
    const id = dlr.messageId;
    const existing = this.orphans.get(id);
    if (existing) clearTimeout(existing.timer);
    else if (this.orphans.size >= this.maxOrphans) {
      const [oldestId, oldest] = this.orphans.entries().next().value ?? [];
      if (oldestId !== undefined && oldest) {
        clearTimeout(oldest.timer);
        this.orphans.delete(oldestId);
      }
    }
    const timer = setTimeout(() => this.orphans.delete(id), this.orphanTtl);
    timer.unref?.();
    this.orphans.set(id, { dlr, timer });
  }

  private finish(entry: Entry, outcome: MessageOutcome): void {
    if (!this.entries.delete(entry)) return;
    clearTimeout(entry.timer);
    if (this.store) this.storeCall(() => this.store!.delete(entry.key));
    for (const id of entry.messageIds) {
      if (this.byId.get(id)?.entry === entry) this.byId.delete(id);
    }
    const status: MessageStatus = {
      outcome,
      messageIds: entry.messageIds,
      parts: entry.messageIds.length,
      reports: entry.reports,
      submittedAt: entry.submittedAt,
    };
    if (entry.reference !== undefined) status.reference = entry.reference;
    this.onStatus(status);
  }
}

/** Dates become strings through JSON: turn them back into `Date`. */
function reviveReport(report: DeliveryReport | null): DeliveryReport | null {
  if (!report) return null;
  const out = { ...report };
  if (typeof out.submitDate === 'string') out.submitDate = new Date(out.submitDate);
  if (typeof out.doneDate === 'string') out.doneDate = new Date(out.doneDate);
  return out;
}
