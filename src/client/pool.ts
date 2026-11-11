import { EventEmitter } from 'node:events';
import type { DataSm, DeliverSm, PduOf, PduParams } from '../codec/pdu.js';
import { encodings } from '../encoding/registry.js';
import {
  SmppAbortError,
  SmppConnectionClosedError,
  SmppError,
  SmppQueueFullError,
  SmppStateError,
  toError,
} from '../errors.js';
import { type Logger, silentLogger } from '../logger.js';
import type { Metric } from '../metrics.js';
import type { RequestCommandName } from '../protocol/commands.js';
import { COMMAND_STATUS } from '../protocol/status.js';
import type { RequestOptions, ResponseOf } from '../session/session.js';
import { DeliveryTracker, type MessageStatus } from '../utils/delivery-tracker.js';
import type { DeliveryReport } from '../utils/dlr.js';
import { type SendTextOptions, type SendTextResult, SmppClient, type SmppClientOptions } from './client.js';
import { type InboundMessage, InboundProcessor } from './inbound.js';
import { type ReconnectOptions, backoffDelay, cancellableSleep } from './reconnect.js';

/**
 * How the pool picks a bind for each send:
 * - `least-busy` (default): the bind with the fewest requests in flight or queued;
 * - `round-robin`: each bind in turn.
 * Only bound members are candidates while at least one is bound.
 */
export type PoolStrategy = 'least-busy' | 'round-robin';

export interface SmppPoolOptions extends SmppClientOptions {
  /** Number of identical binds. Default: 2. Ignored when `members` is set. */
  size?: number;
  /**
   * One entry per bind, merged over the shared options: another host, another system_id, another window…
   * `bind` is merged field by field.
   */
  members?: Array<Partial<SmppClientOptions>>;
  strategy?: PoolStrategy;
  /** `connect()` resolves as soon as this many binds are up. Default: 1. */
  minBound?: number;
}

export interface PoolEvents {
  deliver: [pdu: DeliverSm, member: number];
  dataSm: [pdu: DataSm, member: number];
  alert: [pdu: PduOf<'alert_notification'>, member: number];
  /** Receipts and messages are processed once for the whole pool, whatever bind they arrive on. */
  deliveryReport: [dlr: DeliveryReport, pdu: DeliverSm | DataSm];
  messageStatus: [status: MessageStatus];
  message: [message: InboundMessage];
  partialMessage: [message: InboundMessage];
  /** A bind is up (first connection or reconnection). */
  memberUp: [member: number];
  /** A bind went down or failed to connect. Its reconnection goes on in the background. */
  memberDown: [member: number, error: Error | undefined];
  close: [];
  error: [error: SmppError, member: number];
  /** Metrics of every bind, with the index of the bind. */
  metric: [metric: Metric, member: number];
}

const BOUND = new Set(['BOUND_TX', 'BOUND_RX', 'BOUND_TRX']);

/**
 * Several binds behind one API. Operators often cap the throughput of each bind:
 * a pool spreads the traffic over several, and keeps sending through the others when one goes down.
 *
 * - A message is never resent automatically once written (no duplicates). A send that was not written
 *   (bind closed, queue full) moves to another bind.
 * - All the segments of a `sendText` go through the same bind. Concatenation references are shared,
 *   so two binds never use the same reference at the same time.
 * - Receipts and multipart messages are handled for the whole pool: a receipt, or a segment, may arrive
 *   on another bind than the submit or the first segment.
 */
export class SmppPool extends EventEmitter<PoolEvents> {
  readonly members: readonly SmppClient[];
  private readonly options: SmppPoolOptions;
  private readonly logger: Logger;
  private readonly inbound: InboundProcessor;
  private readonly reconnect: ReconnectOptions | undefined;
  private readonly sleepers = new Set<{ cancel: () => void }>();
  private concatRef = Math.floor(Math.random() * 0x10000);
  private rr = 0;
  private closing = false;
  private connecting: Promise<void> | undefined;
  private onMemberUp: (() => void) | undefined;

  constructor(options: SmppPoolOptions) {
    super();
    this.options = options;
    this.logger = options.logger ?? silentLogger;
    this.reconnect =
      options.reconnect === false
        ? undefined
        : options.reconnect === true || options.reconnect === undefined
          ? {}
          : options.reconnect;
    this.inbound = new InboundProcessor(
      {
        registry: options.encodings ?? encodings,
        logger: this.logger,
        packedGsm7: options.packedGsm7 ?? false,
        messageIdFormat: options.messageIdFormat ?? 'as-is',
        ...(options.reassembly ? { reassembly: options.reassembly } : {}),
        ...(options.trackDeliveries
          ? {
              tracker: new DeliveryTracker(
                (status) => this.emitSafe('messageStatus', status),
                options.trackDeliveries === true ? {} : options.trackDeliveries,
              ),
            }
          : {}),
      },
      {
        deliveryReport: (dlr, pdu) => this.emitSafe('deliveryReport', dlr, pdu),
        message: (msg) => this.emitSafe('message', msg),
        partialMessage: (msg) => this.emitSafe('partialMessage', msg),
      },
    );

    const { size, members, strategy: _s, minBound: _m, ...shared } = options;
    const overrides: Array<Partial<SmppClientOptions>> =
      members ?? Array.from({ length: Math.max(1, size ?? 2) }, () => ({}));
    if (overrides.length === 0) throw new SmppError('SMPP_CONFIG', 'SmppPool needs at least one member');
    this.members = overrides.map((o, i) => {
      const client = new SmppClient(
        {
          ...shared,
          ...o,
          bind: { ...shared.bind, ...o.bind },
          // Tracking is done once for the pool, by the shared inbound processor.
          trackDeliveries: false,
        },
        { inbound: this.inbound, nextConcatRef: () => this.nextConcatRef() },
      );
      this.wire(client, i);
      return client;
    });
  }

  // ---------------------------------------------------------------- state

  /** Number of bound members. */
  get boundCount(): number {
    return this.members.filter((m) => m.isBound).length;
  }

  /** Requests in flight, all members together. */
  get inflight(): number {
    return this.members.reduce((n, m) => n + m.inflight, 0);
  }

  /** Requests queued, all members together. */
  get queueSize(): number {
    return this.members.reduce((n, m) => n + m.queueSize, 0);
  }

  /** Messages awaiting receipts (`trackDeliveries` option). */
  get trackedMessages(): number {
    return this.inbound.tracker?.size ?? 0;
  }

  // ---------------------------------------------------------------- connection

  /**
   * Connects every member. Resolves once `minBound` members are bound; the others keep trying
   * in the background (unless `reconnect: false`). Rejects if every first attempt is over
   * and fewer than `minBound` members are bound.
   */
  connect(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.connecting) return this.connecting;
    this.closing = false;
    const need = Math.min(Math.max(1, this.options.minBound ?? 1), this.members.length);
    this.connecting = (async () => {
      if (this.boundCount >= need) return;
      const ready = new Promise<void>((resolve) => {
        this.onMemberUp = () => {
          if (this.boundCount >= need) resolve();
        };
      });
      const signal = options.signal;
      const aborted = new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const first = Promise.allSettled(this.members.map((_, i) => this.connectMember(i, 1, signal)));
      await Promise.race([ready, first, aborted]);
      if (this.boundCount >= need && !signal?.aborted) return;
      if (signal?.aborted) {
        await this.close();
        throw new SmppAbortError(false, 'connect', { cause: signal.reason });
      }
      const errors = (await first)
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => toError(r.reason));
      await this.close();
      throw new SmppError(
        'SMPP_POOL_CONNECT',
        `Only ${this.boundCount} of the ${need} required binds are up`,
        { cause: new AggregateError(errors, 'Bind failures') },
      );
    })().finally(() => {
      this.connecting = undefined;
      this.onMemberUp = undefined;
    });
    return this.connecting;
  }

  /** Closes every member. `drain: true` waits for pending requests first (see `SmppClient.close`). */
  async close(options: { drain?: boolean; timeout?: number } = {}): Promise<void> {
    this.closing = true;
    for (const s of this.sleepers) s.cancel();
    this.sleepers.clear();
    await Promise.allSettled(this.members.map((m) => m.close(options)));
    this.inbound.clear();
    this.emitSafe('close');
  }

  private async connectMember(index: number, attempt = 1, signal?: AbortSignal): Promise<void> {
    const member = this.members[index]!;
    try {
      await member.connect(signal ? { signal } : {});
    } catch (err) {
      const error = toError(err);
      this.logger.warn('pool member failed to connect', { member: index, attempt, error: error.message });
      this.emitSafe('memberDown', index, error);
      if (!signal?.aborted) this.scheduleRetry(index, attempt);
      throw error;
    }
  }

  /**
   * A member that never bound has no reconnection of its own (`SmppClient` only reconnects after a first
   * success): the pool retries it with the same backoff.
   */
  private scheduleRetry(index: number, attempt: number): void {
    const opts = this.reconnect;
    if (!opts || this.closing) return;
    if (opts.maxAttempts !== undefined && attempt >= opts.maxAttempts) return;
    const sleep = cancellableSleep(backoffDelay(attempt, opts));
    this.sleepers.add(sleep);
    void sleep.promise.then(() => {
      this.sleepers.delete(sleep);
      if (this.closing) return;
      this.connectMember(index, attempt + 1).catch(() => {});
    });
  }

  private wire(client: SmppClient, index: number): void {
    client.on('deliver', (pdu) => this.emitSafe('deliver', pdu, index));
    client.on('dataSm', (pdu) => this.emitSafe('dataSm', pdu, index));
    client.on('alert', (pdu) => this.emitSafe('alert', pdu, index));
    client.on('bound', () => {
      this.emitSafe('memberUp', index);
      this.onMemberUp?.();
    });
    client.on('stateChange', (from, to) => {
      if (BOUND.has(from) && !BOUND.has(to)) this.emitSafe('memberDown', index, undefined);
    });
    client.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emitSafe('error', err, index);
      else this.logger.error(err.message, { code: err.code, member: index });
    });
    client.on('metric', (m) => {
      if (this.listenerCount('metric') > 0) this.emit('metric', m, index);
    });
  }

  // ---------------------------------------------------------------- sending

  /** Sends any request through one member; moves to another if it was not written. */
  request<C extends RequestCommandName>(
    command: C,
    params: PduParams<C> = {} as PduParams<C>,
    options: RequestOptions = {},
  ): Promise<ResponseOf<C>> {
    return this.withMember((m) => m.request(command, params, options));
  }

  submit(params: PduParams<'submit_sm'>, options?: RequestOptions): Promise<ResponseOf<'submit_sm'>> {
    return this.request('submit_sm', params, options);
  }

  /** `SmppClient.sendText` through one member: every segment goes through the same bind. */
  sendText(opts: SendTextOptions): Promise<SendTextResult> {
    return this.withMember((m) => m.sendText(opts));
  }

  query(
    messageId: string,
    params: Omit<PduParams<'query_sm'>, 'message_id'> = {},
    options?: RequestOptions,
  ): Promise<ResponseOf<'query_sm'>> {
    return this.request('query_sm', { ...params, message_id: messageId }, options);
  }

  cancel(
    messageId: string,
    params: Omit<PduParams<'cancel_sm'>, 'message_id'> = {},
    options?: RequestOptions,
  ): Promise<ResponseOf<'cancel_sm'>> {
    return this.request('cancel_sm', { ...params, message_id: messageId }, options);
  }

  replace(
    messageId: string,
    params: Omit<PduParams<'replace_sm'>, 'message_id'>,
    options?: RequestOptions,
  ): Promise<ResponseOf<'replace_sm'>> {
    return this.request('replace_sm', { ...params, message_id: messageId }, options);
  }

  private async withMember<T>(send: (member: SmppClient) => Promise<T>): Promise<T> {
    if (this.closing) {
      throw new SmppStateError('send', 'CLOSING', COMMAND_STATUS.ESME_RINVBNDSTS, 'Pool is closing');
    }
    const tried = new Set<number>();
    let lastError: unknown;
    for (let index = this.pick(tried); index !== undefined; index = this.pick(tried)) {
      tried.add(index);
      try {
        return await send(this.members[index]!);
      } catch (err) {
        if (!notSent(err)) throw err;
        lastError = err;
        this.logger.debug('pool member could not send, trying another one', {
          member: index,
          error: toError(err).message,
        });
      }
    }
    throw (
      lastError ??
      new SmppStateError('send', 'CLOSED', COMMAND_STATUS.ESME_RINVBNDSTS, 'No pool member available')
    );
  }

  /** Index of the member for the next send, among the ones not tried yet. */
  private pick(tried: Set<number>): number | undefined {
    const n = this.members.length;
    const order = Array.from({ length: n }, (_, k) => (this.rr + k) % n).filter((i) => !tried.has(i));
    if (order.length === 0) return undefined;
    const bound = order.filter((i) => this.members[i]!.isBound);
    // No bound member: a reconnecting one keeps the request queued until its re-bind.
    const candidates = bound.length > 0 ? bound : order;
    let chosen = candidates[0]!;
    if ((this.options.strategy ?? 'least-busy') === 'least-busy') {
      let best = Number.POSITIVE_INFINITY;
      for (const i of candidates) {
        const m = this.members[i]!;
        const load = m.inflight + m.queueSize;
        if (load < best) {
          best = load;
          chosen = i;
        }
      }
    }
    this.rr = (chosen + 1) % n;
    return chosen;
  }

  private nextConcatRef(): number {
    this.concatRef = (this.concatRef + 1) & 0xffff;
    return this.concatRef;
  }

  private emitSafe<K extends keyof PoolEvents>(event: K, ...args: PoolEvents[K]): void {
    try {
      (this.emit as (e: K, ...a: PoolEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.logger.error(`listener for "${String(event)}" threw`, { error: toError(err).message });
    }
  }
}

/** The request never reached the SMSC: it can go through another bind without any risk of duplicate. */
function notSent(err: unknown): boolean {
  if (err instanceof SmppConnectionClosedError) return !err.written;
  if (err instanceof SmppQueueFullError) return true;
  // Member not connected (and not reconnecting): refused before anything was written.
  return err instanceof SmppStateError && (err.state === 'CLOSED' || err.state === 'CLOSING');
}
