export interface RateLimitOptions {
  /** Sustained rate, in PDUs per second. */
  perSecond: number;
  /** Maximum burst. Default: `perSecond`. */
  burst?: number;
  /** Reduction factor applied on ESME_RTHROTTLED / ESME_RMSGQFUL. Default: 0.5. */
  backoffFactor?: number;
  /** Minimum rate after successive reductions, as a fraction of the nominal rate. Default: 0.1. */
  minFactor?: number;
  /** How long a reduction lasts before gradually returning to the nominal rate. Default: 10 s. */
  cooldownMs?: number;
}

/** Token bucket with adaptive rate reduction (REL-04). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private rate: number;
  private readonly baseRate: number;
  private readonly burst: number;
  private readonly backoffFactor: number;
  private readonly minRate: number;
  private readonly cooldownMs: number;
  private penaltyUntil = 0;

  constructor(
    options: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {
    if (!(options.perSecond > 0)) throw new RangeError('rateLimit.perSecond must be > 0');
    this.baseRate = options.perSecond;
    this.rate = options.perSecond;
    this.burst = Math.max(1, options.burst ?? options.perSecond);
    this.backoffFactor = options.backoffFactor ?? 0.5;
    this.minRate = options.perSecond * (options.minFactor ?? 0.1);
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.tokens = this.burst;
    this.last = this.now();
  }

  /** Current rate (PDUs/s). */
  get currentRate(): number {
    this.refill();
    return this.rate;
  }

  private refill(): void {
    const t = this.now();
    if (this.penaltyUntil !== 0 && t >= this.penaltyUntil) {
      // Gradual recovery: double the rate for every period without a new penalty.
      this.rate = Math.min(this.baseRate, this.rate * 2);
      this.penaltyUntil = this.rate < this.baseRate ? t + this.cooldownMs : 0;
    }
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
      this.last = t;
    }
  }

  /** Takes a token. Returns 0 if granted, otherwise the wait in ms. */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
  }

  /** Temporarily reduces the rate (SMSC overloaded). */
  penalize(): void {
    this.refill();
    this.rate = Math.max(this.minRate, this.rate * this.backoffFactor);
    this.tokens = Math.min(this.tokens, 0);
    this.penaltyUntil = this.now() + this.cooldownMs;
  }
}
