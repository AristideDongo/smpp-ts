export interface RateLimitOptions {
  /** Débit soutenu, en PDU par seconde. */
  perSecond: number;
  /** Rafale maximale. Défaut : `perSecond`. */
  burst?: number;
  /** Facteur de réduction appliqué sur ESME_RTHROTTLED / ESME_RMSGQFUL. Défaut : 0.5. */
  backoffFactor?: number;
  /** Débit minimal après réductions successives, en fraction du débit nominal. Défaut : 0.1. */
  minFactor?: number;
  /** Durée de la réduction avant retour progressif au débit nominal. Défaut : 10 s. */
  cooldownMs?: number;
}

/** Seau à jetons avec réduction adaptative du débit (REL-04). */
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

  /** Débit courant (PDU/s). */
  get currentRate(): number {
    this.refill();
    return this.rate;
  }

  private refill(): void {
    const t = this.now();
    if (this.penaltyUntil !== 0 && t >= this.penaltyUntil) {
      // Retour progressif : on double le débit à chaque période sans nouvelle pénalité.
      this.rate = Math.min(this.baseRate, this.rate * 2);
      this.penaltyUntil = this.rate < this.baseRate ? t + this.cooldownMs : 0;
    }
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
      this.last = t;
    }
  }

  /** Prend un jeton. Renvoie 0 si accordé, sinon le délai d'attente en ms. */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
  }

  /** Réduit temporairement le débit (SMSC saturé). */
  penalize(): void {
    this.refill();
    this.rate = Math.max(this.minRate, this.rate * this.backoffFactor);
    this.tokens = Math.min(this.tokens, 0);
    this.penaltyUntil = this.now() + this.cooldownMs;
  }
}
