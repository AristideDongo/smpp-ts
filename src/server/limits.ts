/**
 * Admission limits of the server, before any SMPP byte is read (SEC-05).
 *
 * `maxSessions` / `maxSessionsPerIp` bound how many connections live at the same time; they say
 * nothing about how fast connections are opened. A peer that connects and disconnects in a loop
 * (worse, over TLS: one handshake each time) burns CPU without ever reaching those limits.
 */

/** Connection rate policy. */
export interface ConnectionRatePolicy {
  /** Connections per second accepted from one address. Default: 20. 0 = no limit. */
  perIpPerSecond?: number;
  /** Burst tolerated from one address (a pool opens its binds at once). Default: 2 × the rate. */
  perIpBurst?: number;
  /** Connections per second accepted in total. Default: 0 (no limit). */
  perSecond?: number;
  /** Total burst. Default: 2 × the rate. */
  burst?: number;
  /**
   * Addresses tracked at once. Default: 10 000. Beyond it the least recently seen are dropped,
   * which bounds the memory a flood from many addresses can take.
   */
  maxTracked?: number;
}

/** Why a connection was refused. */
export type ConnectionRateVerdict = 'ok' | 'ip-rate' | 'total-rate';

interface Bucket {
  tokens: number;
  last: number;
}

/** Plain token bucket, no penalty or cooldown: admission control only. */
class Buckets {
  constructor(
    readonly rate: number,
    readonly burst: number,
  ) {}

  take(bucket: Bucket, now: number): boolean {
    const elapsed = (now - bucket.last) / 1000;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.rate);
      bucket.last = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  fresh(now: number): Bucket {
    return { tokens: this.burst, last: now };
  }

  /** A bucket back at full capacity carries no information: it can be forgotten. */
  isIdle(bucket: Bucket, now: number): boolean {
    return bucket.tokens + ((now - bucket.last) / 1000) * this.rate >= this.burst;
  }
}

/** Limits the rate of accepted connections, globally and per address. */
export class ConnectionRateLimiter {
  private readonly perIp: Buckets | undefined;
  private readonly total: Buckets | undefined;
  private readonly totalBucket: Bucket | undefined;
  private readonly entries = new Map<string, Bucket>();
  private readonly maxTracked: number;

  constructor(
    policy: ConnectionRatePolicy = {},
    private readonly now: () => number = Date.now,
  ) {
    const perIpRate = policy.perIpPerSecond ?? 20;
    if (perIpRate > 0) this.perIp = new Buckets(perIpRate, Math.max(1, policy.perIpBurst ?? perIpRate * 2));
    const totalRate = policy.perSecond ?? 0;
    if (totalRate > 0) {
      this.total = new Buckets(totalRate, Math.max(1, policy.burst ?? totalRate * 2));
      this.totalBucket = this.total.fresh(this.now());
    }
    this.maxTracked = Math.max(1, policy.maxTracked ?? 10_000);
  }

  /** Addresses tracked at this instant. */
  get size(): number {
    return this.entries.size;
  }

  /** Takes one admission token for `ip`. Nothing is consumed when the answer is not `ok`. */
  check(ip: string): ConnectionRateVerdict {
    const t = this.now();
    if (this.perIp) {
      let bucket = this.entries.get(ip);
      if (!bucket) {
        this.prune(t);
        bucket = this.perIp.fresh(t);
      } else {
        // Re-inserted last: the Map keeps insertion order, so the first entry is the oldest.
        this.entries.delete(ip);
      }
      this.entries.set(ip, bucket);
      if (!this.perIp.take(bucket, t)) return 'ip-rate';
    }
    if (this.total && this.totalBucket && !this.total.take(this.totalBucket, t)) {
      return 'total-rate';
    }
    return 'ok';
  }

  private prune(t: number): void {
    if (this.entries.size < this.maxTracked || !this.perIp) return;
    for (const [ip, bucket] of this.entries) {
      if (this.perIp.isIdle(bucket, t)) this.entries.delete(ip);
    }
    while (this.entries.size >= this.maxTracked) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
