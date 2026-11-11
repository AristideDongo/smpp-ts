export interface BackoffOptions {
  /** First delay. Default: 1 s. */
  initialDelay?: number;
  /** Maximum delay. Default: 30 s. */
  maxDelay?: number;
  /** Multiplier between two attempts. Default: 2. */
  multiplier?: number;
  /** Random share of the delay (0 = none, 1 = all of it). Default: 0.5. */
  jitter?: number;
}

export interface ReconnectOptions extends BackoffOptions {
  /** Maximum number of attempts. Default: unlimited. */
  maxAttempts?: number;
}

export interface RetryOptions extends BackoffOptions {
  /**
   * Number of retries on a temporary status (ESME_RTHROTTLED, ESME_RMSGQFUL, ESME_RSYSERR…).
   * Default: 2. Each attempt gets its own `requestTimeout`.
   */
  maxRetries?: number;
}

/** Delay before attempt `attempt` (1 = first): exponential backoff with jitter. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const initial = options.initialDelay ?? 1_000;
  const max = options.maxDelay ?? 30_000;
  const multiplier = options.multiplier ?? 2;
  const jitter = Math.min(1, Math.max(0, options.jitter ?? 0.5));
  const base = Math.min(max, initial * multiplier ** Math.max(0, attempt - 1));
  return Math.round(base * (1 - jitter) + base * jitter * random());
}

/** Cancellable `setTimeout`. */
export function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      done();
    },
  };
}
