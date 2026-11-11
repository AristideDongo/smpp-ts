import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares two strings in constant time (independent of content AND length),
 * for simple `authenticate` hook implementations (SEC-06).
 */
export function safeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export interface BindFailurePolicy {
  /** Failures tolerated within the window before a ban. Default: 5. */
  maxAttempts?: number;
  /** Counting window. Default: 60 s. */
  windowMs?: number;
  /** Ban duration. Default: 5 min. */
  banMs?: number;
}

/** Limits failed bind attempts per IP (SEC-05). */
export class BindFailureTracker {
  private readonly entries = new Map<string, { failures: number[]; bannedUntil: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly banMs: number;

  constructor(
    policy: BindFailurePolicy = {},
    private readonly now: () => number = Date.now,
  ) {
    this.maxAttempts = policy.maxAttempts ?? 5;
    this.windowMs = policy.windowMs ?? 60_000;
    this.banMs = policy.banMs ?? 5 * 60_000;
  }

  isBanned(ip: string): boolean {
    const e = this.entries.get(ip);
    if (!e) return false;
    if (e.bannedUntil > this.now()) return true;
    if (e.bannedUntil !== 0) this.entries.delete(ip);
    return false;
  }

  /** Records a failure; returns `true` if the IP has just been banned. */
  recordFailure(ip: string): boolean {
    const t = this.now();
    const e = this.entries.get(ip) ?? { failures: [], bannedUntil: 0 };
    e.failures = e.failures.filter((f) => t - f < this.windowMs);
    e.failures.push(t);
    let banned = false;
    if (e.failures.length >= this.maxAttempts) {
      e.bannedUntil = t + this.banMs;
      e.failures = [];
      banned = true;
    }
    this.entries.set(ip, e);
    this.prune(t);
    return banned;
  }

  recordSuccess(ip: string): void {
    const e = this.entries.get(ip);
    if (e && e.bannedUntil === 0) this.entries.delete(ip);
  }

  private prune(t: number): void {
    if (this.entries.size < 10_000) return;
    for (const [ip, e] of this.entries) {
      if (e.bannedUntil < t && e.failures.every((f) => t - f >= this.windowMs)) this.entries.delete(ip);
    }
  }
}
