import type { DeliveryReport, DlrStatus } from './dlr.js';

/**
 * Issue agrégée d'un message (éventuellement multi-segments) :
 * - `DELIVERED` : tous les segments ont été remis ;
 * - `FAILED` : aucun segment n'a été remis ;
 * - `PARTIALLY_DELIVERED` : certains segments seulement ;
 * - `TIMEOUT` : tous les accusés finaux ne sont pas arrivés dans le délai (`ttl`) ou le suivi a été évincé.
 */
export type MessageOutcome = 'DELIVERED' | 'FAILED' | 'PARTIALLY_DELIVERED' | 'TIMEOUT';

export interface MessageStatus {
  outcome: MessageOutcome;
  /** `message_id` de chaque segment, dans l'ordre d'envoi. */
  messageIds: string[];
  parts: number;
  /** Accusé final de chaque segment (même index que `messageIds`), `undefined` s'il n'est pas arrivé. */
  reports: Array<DeliveryReport | undefined>;
  /** Référence applicative passée à `track()` / `sendText({ reference })`. */
  reference?: string;
  /** Date du premier `track()`. */
  submittedAt: Date;
}

export interface DeliveryTrackerOptions {
  /** Durée maximale d'attente des accusés finaux. Défaut : 24 h. */
  ttl?: number;
  /** Nombre maximal de messages suivis ; au-delà, le plus ancien est clos en `TIMEOUT`. Défaut : 100 000. */
  maxTracked?: number;
  /**
   * Durée de conservation d'un accusé arrivé avant son `submit_sm_resp`
   * (possible pour les segments d'un message long). Défaut : 60 s.
   */
  orphanTtl?: number;
  /** Nombre maximal d'accusés orphelins conservés. Défaut : 10 000. */
  maxOrphans?: number;
}

/** Statuts qui ne changeront plus : l'accusé est final. */
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
 * Regroupe les accusés de réception des segments d'un même message et signale
 * son issue une fois tous les accusés finaux reçus (ou à expiration du `ttl`).
 *
 * Mémoire bornée (`maxTracked`, `maxOrphans`) ; aucune persistance : après un redémarrage,
 * c'est à l'application de rapprocher les accusés de ses propres enregistrements.
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

  /** Messages en attente d'accusés. */
  get size(): number {
    return this.entries.size;
  }

  /** Commence le suivi d'un message à partir des `message_id` de ses segments. */
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
      if (!this.entries.has(entry)) return; // déjà clos par un orphelin précédent
      this.handle(orphan.dlr);
    }
  }

  /**
   * Traite un accusé. Renvoie `true` s'il correspond à un message suivi.
   * Un accusé final sans correspondance est conservé `orphanTtl` ms au cas où le `track()` arrive après.
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

  /** Abandonne tout suivi en cours, sans émettre de statut. */
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
