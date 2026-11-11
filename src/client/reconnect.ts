export interface BackoffOptions {
  /** Premier délai. Défaut : 1 s. */
  initialDelay?: number;
  /** Délai maximal. Défaut : 30 s. */
  maxDelay?: number;
  /** Multiplicateur entre deux tentatives. Défaut : 2. */
  multiplier?: number;
  /** Part aléatoire du délai (0 = aucune, 1 = totale). Défaut : 0.5. */
  jitter?: number;
}

export interface ReconnectOptions extends BackoffOptions {
  /** Nombre maximal de tentatives. Défaut : illimité. */
  maxAttempts?: number;
}

export interface RetryOptions extends BackoffOptions {
  /**
   * Nombre de nouvelles tentatives sur statut temporaire (ESME_RTHROTTLED, ESME_RMSGQFUL, ESME_RSYSERR…).
   * Défaut : 2. Chaque tentative a son propre `requestTimeout`.
   */
  maxRetries?: number;
}

/** Délai avant la tentative `attempt` (1 = première), backoff exponentiel avec gigue. */
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

/** `setTimeout` annulable. */
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
