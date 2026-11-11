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
 * Bounded memory (`maxTracked`, `maxOrphans`); no persistence: after a restart,
 * the application matches receipts against its own records.
 */
export class DeliveryTracker {
  private readonly entries = new Map<Entry, true>();
  private readonly byId = new Map<string, { entry: Entry; index: number }>();
  private readonly orphans = new Map<string, Orphan>();
  private readonly ttl: number;
  private readonly maxTracked: number;
  private readonly orphanTtl: number;
  private readonly maxOrphans: number;

  constructor(
    private readonly onStatus: (status: MessageStatus) => void,
    options: DeliveryTrackerOptions = {},
  ) {
    this.ttl = options.ttl ?? 24 * 60 * 60 * 1000;
    this.maxTracked = options.maxTracked ?? 100_000;
    this.orphanTtl = options.orphanTtl ?? 60_000;
    this.maxOrphans = options.maxOrphans ?? 10_000;
  }

  /** Messages awaiting receipts. */
  get size(): number {
    return this.entries.size;
  }

  /** Starts tracking a message from the `message_id` of its segments. */
  track(messageIds: readonly string[], reference?: string): void {
    if (messageIds.length === 0) return;
    while (this.entries.size >= this.maxTracked) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.finish(oldest, 'TIMEOUT');
    }
    const timer = setTimeout(() => this.finish(entry, 'TIMEOUT'), this.ttl);
    timer.unref?.();
    const entry: Entry = {
      messageIds: messageIds.map((id) => id.trim()),
      reports: new Array(messageIds.length).fill(undefined),
      remaining: messageIds.length,
      reference,
      submittedAt: new Date(),
      timer,
    };
    this.entries.set(entry, true);
    entry.messageIds.forEach((id, index) => this.byId.set(id, { entry, index }));

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
    if (entry.remaining === 0) {
      const delivered = entry.reports.filter((r) => r?.status === 'DELIVERED').length;
      this.finish(
        entry,
        delivered === entry.reports.length ? 'DELIVERED' : delivered === 0 ? 'FAILED' : 'PARTIALLY_DELIVERED',
      );
    }
    return true;
  }

  /** Drops all tracking in progress, without emitting any status. */
  clear(): void {
    for (const entry of this.entries.keys()) clearTimeout(entry.timer);
    for (const orphan of this.orphans.values()) clearTimeout(orphan.timer);
    this.entries.clear();
    this.byId.clear();
    this.orphans.clear();
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
