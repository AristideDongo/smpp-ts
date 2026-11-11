import { EventEmitter } from 'node:events';
import {
  type CodecOptions,
  type DataSm,
  type DeliverSm,
  type Pdu,
  PduCodec,
  type PduOf,
  type PduParams,
} from '../codec/pdu.js';
import type { NationalLanguage } from '../encoding/gsm7.js';
import { type EncodingRegistry, encodings } from '../encoding/registry.js';
import {
  SmppAbortError,
  SmppConnectionClosedError,
  SmppError,
  SmppMultipartError,
  SmppStateError,
  SmppStatusError,
  SmppValidationError,
  toError,
} from '../errors.js';
import { type Logger, silentLogger } from '../logger.js';
import type { Metric } from '../metrics.js';
import { COMMANDS, type RequestCommandName, responseNameOf } from '../protocol/commands.js';
import { REGISTERED_DELIVERY } from '../protocol/constants.js';
import { COMMAND_STATUS, type StatusCategory, defaultStatusClassifier } from '../protocol/status.js';
import { type RateLimitOptions, TokenBucket } from '../session/rate-limiter.js';
import { type RequestOptions, type ResponseOf, Session } from '../session/session.js';
import { type BindMode, type SessionState, canSendInMode } from '../session/state-machine.js';
import { RequestQueue, createPendingRequest } from '../session/window.js';
import {
  type Endpoint,
  type TlsClientOptions,
  connectSocket,
  parseSmppUrl,
} from '../transport/connection.js';
import { type AddressOptions, resolveAddress } from '../utils/address.js';
import {
  DeliveryTracker,
  type DeliveryTrackerOptions,
  type MessageStatus,
} from '../utils/delivery-tracker.js';
import {
  type DeliveryReport,
  type MessageIdFormat,
  buildDeliveryReport,
  isDeliveryReceipt,
} from '../utils/dlr.js';
import {
  type ReassembledMessage,
  Reassembler,
  buildParts,
  decodeMessageContent,
} from '../utils/multipart.js';
import type { MultipartStrategy } from '../utils/segments.js';
import { formatAbsoluteTime, formatRelativeTime } from '../utils/time.js';
import { type ReconnectOptions, type RetryOptions, backoffDelay, cancellableSleep } from './reconnect.js';

export interface BindOptions {
  mode: BindMode;
  system_id: string;
  password: string;
  system_type?: string;
  /** Default: 0x34 (SMPP v3.4, the most widely accepted). 0x50 for v5.0. */
  interface_version?: number;
  addr_ton?: number;
  addr_npi?: number;
  address_range?: string;
}

export interface SmppClientOptions {
  /** `smpp://host:port` or `ssmpp://host:port` (TLS). */
  url?: string;
  host?: string;
  port?: number;
  /** Enables TLS (and/or sets its options). Certificate verification is on by default. */
  tls?: boolean | TlsClientOptions;
  bind: BindOptions;

  /** Concurrent in-flight requests. Default: 10. */
  window?: number;
  /** Send queue size. Default: 10 000. */
  maxQueueSize?: number;
  rateLimit?: RateLimitOptions;
  /** Automatic reconnection. Default: enabled, unlimited attempts. */
  reconnect?: boolean | ReconnectOptions;
  /** Retries on temporary statuses. `false` to disable. */
  retry?: false | RetryOptions;
  /** command_status classification (REL-06). */
  classifyStatus?: (status: number, defaultCategory: StatusCategory) => StatusCategory;

  connectTimeout?: number;
  bindTimeout?: number;
  requestTimeout?: number;
  enquireLinkInterval?: number;
  enquireLinkTimeout?: number;
  unbindTimeout?: number;

  logger?: Logger;
  /** Masks SMS content in logs. */
  redactContent?: boolean;
  /** Partially masks phone numbers in logs. */
  redactNumbers?: boolean;

  /** Automatically answers deliver_sm_resp / data_sm_resp (status 0). Default: true. */
  autoAck?: boolean;
  /** message_id normalization for delivery receipts. Default: `as-is`. */
  messageIdFormat?: MessageIdFormat;
  /** Normalization and validation of `sendText` addresses (numbers, alphanumeric sender). */
  address?: AddressOptions;
  /**
   * Groups the receipts of every segment of a message sent with `sendText` (with `registeredDelivery`)
   * and emits `messageStatus` with the overall outcome. Disabled by default.
   */
  trackDeliveries?: boolean | DeliveryTrackerOptions;
  multipart?: {
    strategy?: MultipartStrategy;
    /** National shift tables allowed during automatic detection. */
    shiftTables?: NationalLanguage[];
    allowLatin1?: boolean;
    packGsm7?: boolean;
    /**
     * Maximum number of segments for one `sendText` (each segment is billed as one SMS).
     * A longer text is rejected before anything is sent. Default: 255 (protocol maximum).
     */
    maxSegments?: number;
  };
  /** Bytes allowed in the socket write buffer before the session is closed. Default: 1 MiB. */
  maxWriteBuffer?: number;
  reassembly?: { ttl?: number; maxBuffers?: number };
  /** Incoming GSM7 septets are packed. Default: false. */
  packedGsm7?: boolean;
  encodings?: EncodingRegistry;
  codec?: CodecOptions;
}

export interface SendTextOptions {
  to: string;
  from: string;
  text: string;
  /** Forced encoding (`gsm7`, `latin1`, `ucs2`, `ascii` or a registered encoding). */
  encoding?: string;
  shift?: NationalLanguage;
  strategy?: MultipartStrategy;
  /** `true` = receipt for the final outcome; or a registered_delivery value. */
  registeredDelivery?: boolean | number;
  /** Absolute expiry date, duration in ms, or SMPP time string. */
  validityPeriod?: Date | number | string;
  scheduleDeliveryTime?: Date | number | string;
  serviceType?: string;
  sourceTon?: number;
  sourceNpi?: number;
  destTon?: number;
  destNpi?: number;
  priority?: number;
  /** Extra submit_sm parameters (TLVs…). */
  params?: PduParams<'submit_sm'>;
  timeout?: number;
  /** Cancels the segments not sent yet (`SmppAbortError`). */
  signal?: AbortSignal;
  /** Overrides `multipart.maxSegments` for this message. */
  maxSegments?: number;
  /**
   * Flash SMS (message class 0): displayed at once and not stored by the handset.
   * Supported with GSM7, UCS2 and binary content; rejected with Latin-1 and ASCII.
   */
  flash?: boolean;
  /** Application reference echoed in the `messageStatus` event (with `trackDeliveries`). */
  reference?: string;
}

export interface SendTextResult {
  messageIds: string[];
  parts: number;
  encoding: string;
}

export interface InboundMessage {
  from: string;
  to: string;
  /** Text, or `undefined` for binary content. */
  text?: string;
  body: Buffer;
  dataCoding: number;
  parts: number;
  /** Missing segments (partialMessage only). */
  missing: number[];
  pdus: Array<DeliverSm | DataSm>;
}

export interface ClientEvents {
  stateChange: [from: SessionState, to: SessionState];
  bound: [systemId: string];
  deliver: [pdu: DeliverSm];
  dataSm: [pdu: DataSm];
  alert: [pdu: PduOf<'alert_notification'>];
  deliveryReport: [dlr: DeliveryReport, pdu: DeliverSm | DataSm];
  /** Overall outcome of a tracked message (`trackDeliveries` option). */
  messageStatus: [status: MessageStatus];
  message: [message: InboundMessage];
  partialMessage: [message: InboundMessage];
  reconnecting: [attempt: number, delayMs: number];
  reconnected: [];
  reconnectFailed: [error: Error];
  close: [];
  error: [error: SmppError];
  metric: [metric: Metric];
}

type RawCommand = Exclude<
  RequestCommandName,
  | 'bind_transmitter'
  | 'bind_receiver'
  | 'bind_transceiver'
  | 'unbind'
  | 'outbind'
  | 'alert_notification'
  | 'deliver_sm'
>;

/** Low-level shortcuts: `client.raw.submit_sm({...})`. */
export type RawApi = {
  [C in RawCommand]: (params?: PduParams<C>, options?: RequestOptions) => Promise<ResponseOf<C>>;
};

/** SMPP client (ESME). */
export class SmppClient extends EventEmitter<ClientEvents> {
  readonly raw: RawApi;
  private readonly options: SmppClientOptions;
  private readonly endpoint: Endpoint;
  private readonly tlsOptions: TlsClientOptions | undefined;
  private readonly logger: Logger;
  private readonly queue: RequestQueue;
  private readonly codec: PduCodec;
  private readonly registry: EncodingRegistry;
  private readonly rateLimiter: TokenBucket | undefined;
  private readonly reassembler: Reassembler<DeliverSm | DataSm>;
  private readonly reconnectOptions: ReconnectOptions | undefined;
  private readonly retryOptions: RetryOptions | undefined;
  private readonly tracker: DeliveryTracker | undefined;

  private session: Session | undefined;
  private connecting: Promise<void> | undefined;
  private everBound = false;
  private reconnecting = false;
  private closing = false;
  private sleeper: { cancel: () => void } | undefined;
  private concatRef = Math.floor(Math.random() * 0x10000);

  constructor(options: SmppClientOptions) {
    super();
    this.options = options;
    this.logger = options.logger ?? silentLogger;
    this.endpoint = resolveEndpoint(options);
    this.tlsOptions = typeof options.tls === 'object' ? options.tls : undefined;
    this.queue = new RequestQueue(options.maxQueueSize ?? 10_000);
    this.codec = new PduCodec(options.codec);
    this.registry = options.encodings ?? encodings;
    this.rateLimiter = options.rateLimit ? new TokenBucket(options.rateLimit) : undefined;
    this.reconnectOptions =
      options.reconnect === false
        ? undefined
        : options.reconnect === true || options.reconnect === undefined
          ? {}
          : options.reconnect;
    this.retryOptions = options.retry === false ? undefined : (options.retry ?? {});
    this.reassembler = new Reassembler({
      ...(options.reassembly?.ttl !== undefined ? { ttl: options.reassembly.ttl } : {}),
      ...(options.reassembly?.maxBuffers !== undefined ? { maxBuffers: options.reassembly.maxBuffers } : {}),
      registry: this.registry,
      onPartial: (msg) => this.emitSafe('partialMessage', toInbound(msg)),
    });
    if (!options.bind?.system_id || options.bind.password === undefined) {
      throw new SmppError('SMPP_CONFIG', 'bind.system_id and bind.password are required');
    }
    this.tracker = options.trackDeliveries
      ? new DeliveryTracker(
          (status) => this.emitSafe('messageStatus', status),
          options.trackDeliveries === true ? {} : options.trackDeliveries,
        )
      : undefined;
    this.raw = this.buildRaw();
  }

  /** Messages awaiting receipts (`trackDeliveries` option). */
  get trackedMessages(): number {
    return this.tracker?.size ?? 0;
  }

  // ---------------------------------------------------------------- state

  get state(): SessionState {
    return this.session?.state ?? 'CLOSED';
  }

  get isBound(): boolean {
    const s = this.state;
    return s === 'BOUND_TX' || s === 'BOUND_RX' || s === 'BOUND_TRX';
  }

  /** Queued requests (not written yet). */
  get queueSize(): number {
    return this.queue.size;
  }

  /** In-flight requests. */
  get inflight(): number {
    return this.session?.inflightCount ?? 0;
  }

  // ---------------------------------------------------------------- connection

  /**
   * Connects and binds. Rejects if the first attempt fails;
   * automatic reconnection takes over after that if the connection drops.
   */
  async connect(): Promise<void> {
    if (this.isBound) return;
    if (this.connecting) return this.connecting;
    this.closing = false;
    this.connecting = this.establish().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
    this.everBound = true;
  }

  private async establish(): Promise<void> {
    const o = this.options;
    const socket = await connectSocket(this.endpoint, {
      ...(o.connectTimeout !== undefined ? { connectTimeout: o.connectTimeout } : {}),
      ...(this.tlsOptions ? { tls: this.tlsOptions } : {}),
      logger: this.logger,
    });
    if (this.closing) {
      socket.destroy();
      throw new SmppConnectionClosedError(false, 'Client closed during connect');
    }
    const classify = o.classifyStatus;
    const session = new Session(socket, {
      role: 'esme',
      codec: this.codec,
      logger: this.logger,
      redact: { redactContent: o.redactContent ?? false, redactNumbers: o.redactNumbers ?? false },
      window: o.window ?? 10,
      queue: this.queue,
      ...(this.rateLimiter ? { rateLimiter: this.rateLimiter } : {}),
      ...(classify ? { classifyStatus: (s: number) => classify(s, defaultStatusClassifier(s)) } : {}),
      ...pick(o, [
        'requestTimeout',
        'enquireLinkInterval',
        'enquireLinkTimeout',
        'unbindTimeout',
        'maxWriteBuffer',
      ]),
      logContext: { systemId: o.bind.system_id, host: this.endpoint.host },
    });
    this.session = session;
    session.on('stateChange', (from, to) => this.emitSafe('stateChange', from, to));
    // The CLOSED → OPEN transition happens in the session constructor: relay it here.
    this.emitSafe('stateChange', 'CLOSED', 'OPEN');
    session.on('metric', (m) => this.emit('metric', m));
    session.on('error', (err) => this.emitError(err));
    session.on('pdu', (pdu) => this.onPdu(session, pdu));
    session.on('close', (err) => this.onSessionClose(session, err));

    const { mode, ...bindParams } = o.bind;
    try {
      await session.bind(mode, { interface_version: 0x34, ...bindParams }, o.bindTimeout ?? 10_000);
    } catch (err) {
      session.destroy();
      await session.closedSignal;
      throw err;
    }
    this.emitSafe('bound', o.bind.system_id);
  }

  private onSessionClose(session: Session, err: Error | undefined): void {
    if (session !== this.session) return;
    this.session = undefined;
    if (this.closing || !this.reconnectOptions || !this.everBound) {
      if (!this.connecting) this.finalClose(err);
      return;
    }
    void this.reconnectLoop(err);
  }

  private async reconnectLoop(cause: Error | undefined): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const opts = this.reconnectOptions ?? {};
    let lastError = cause ?? new SmppConnectionClosedError(false, 'Connection lost');
    try {
      for (let attempt = 1; !this.closing; attempt++) {
        if (opts.maxAttempts !== undefined && attempt > opts.maxAttempts) {
          this.logger.error('reconnection failed', { attempts: attempt - 1, error: lastError.message });
          this.emitSafe('reconnectFailed', lastError);
          this.finalClose(lastError);
          return;
        }
        const delay = backoffDelay(attempt, opts);
        this.logger.info('reconnecting', { attempt, delayMs: delay });
        this.emitSafe('reconnecting', attempt, delay);
        this.emit('metric', { name: 'session.reconnect', type: 'counter', value: 1 });
        const sleep = cancellableSleep(delay);
        this.sleeper = sleep;
        await sleep.promise;
        this.sleeper = undefined;
        if (this.closing) return;
        try {
          await this.establish();
          this.logger.info('reconnected', { attempt });
          this.emitSafe('reconnected');
          return;
        } catch (err) {
          lastError = toError(err);
          this.logger.warn('reconnection attempt failed', { attempt, error: lastError.message });
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private finalClose(cause: Error | undefined): void {
    // Messages never written can be resent without any risk of duplicates.
    this.queue.rejectAll(
      () => new SmppConnectionClosedError(false, 'Client closed before sending', { cause }),
    );
    this.reassembler.clear();
    this.tracker?.clear();
    this.emitSafe('close');
  }

  /**
   * Graceful shutdown (REL-07).
   * `drain: true` refuses new sends, waits for queued and in-flight requests
   * (at most `timeout`, default `requestTimeout`), then unbinds and closes.
   */
  async close(options: { drain?: boolean; timeout?: number } = {}): Promise<void> {
    this.closing = true;
    this.sleeper?.cancel();
    const session = this.session;
    if (options.drain && session) {
      const deadline = Date.now() + (options.timeout ?? this.options.requestTimeout ?? 10_000);
      while (
        (this.queue.size > 0 || session.inflightCount > 0) &&
        Date.now() < deadline &&
        !session.isClosed
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    this.queue.rejectAll(() => new SmppConnectionClosedError(false, 'Client closing'));
    if (session && !session.isClosed) {
      await session.close();
    } else if (!session) {
      this.finalClose(undefined);
    }
  }

  // ---------------------------------------------------------------- sending

  /**
   * Sends any SMPP request and waits for its response.
   * Temporary statuses are retried with backoff (see `retry`).
   */
  async request<C extends RequestCommandName>(
    command: C,
    params: PduParams<C> = {} as PduParams<C>,
    options: RequestOptions = {},
  ): Promise<ResponseOf<C>> {
    const maxRetries = this.retryOptions?.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(command, params, options);
      } catch (err) {
        if (
          !(err instanceof SmppStatusError) ||
          err.category !== 'temporary' ||
          !this.retryOptions ||
          attempt >= maxRetries ||
          this.closing
        ) {
          throw err;
        }
        const delay = backoffDelay(attempt + 1, {
          initialDelay: 500,
          maxDelay: 10_000,
          ...this.retryOptions,
        });
        this.logger.debug('retrying after temporary error', {
          command,
          status: err.statusName,
          delayMs: delay,
        });
        await abortableDelay(delay, options.signal, command);
      }
    }
  }

  private requestOnce<C extends RequestCommandName>(
    command: C,
    params: PduParams<C>,
    options: RequestOptions,
  ): Promise<ResponseOf<C>> {
    if (this.closing) {
      return Promise.reject(
        new SmppStateError(`send ${command}`, 'CLOSING', COMMAND_STATUS.ESME_RINVBNDSTS, 'Client is closing'),
      );
    }
    // SEC-07: refuse locally a command the bind mode does not allow.
    if (command !== 'enquire_link' && !canSendInMode('esme', this.options.bind.mode, command)) {
      return Promise.reject(
        new SmppStateError(
          `send ${command}`,
          this.options.bind.mode,
          COMMAND_STATUS.ESME_RINVBNDSTS,
          `${command} is not allowed in ${this.options.bind.mode} mode`,
        ),
      );
    }
    const session = this.session;
    if (session && !session.isClosed) return session.request(command, params, options);
    if (!this.everBound || !this.reconnectOptions) {
      return Promise.reject(
        new SmppStateError(
          `send ${command}`,
          'CLOSED',
          COMMAND_STATUS.ESME_RINVBNDSTS,
          'Client is not connected',
        ),
      );
    }
    // Reconnecting: the request waits in the queue and goes out after the re-bind (REL-05).
    try {
      const encoded = this.codec.encode({ ...params, command, sequence_number: 0 } as never);
      const timeoutMs = options.timeout ?? this.options.requestTimeout ?? 10_000;
      const { request, promise } = createPendingRequest({
        command,
        encoded,
        timeoutMs,
        signal: options.signal,
      });
      this.queue.push(request);
      return promise as Promise<ResponseOf<C>>;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Low-level submit_sm. */
  submit(params: PduParams<'submit_sm'>, options?: RequestOptions): Promise<ResponseOf<'submit_sm'>> {
    return this.request('submit_sm', params, options);
  }

  /**
   * Sends a text: picks the encoding, splits it into segments,
   * returns every message_id.
   */
  async sendText(opts: SendTextOptions): Promise<SendTextResult> {
    // Addresses are validated first: no request goes out for an invalid message.
    const addressing = this.options.address ?? {};
    const source = resolveAddress(opts.from, 'source', {
      ...addressing,
      ton: opts.sourceTon,
      npi: opts.sourceNpi,
    });
    const dest = resolveAddress(opts.to, 'destination', {
      ...addressing,
      ton: opts.destTon,
      npi: opts.destNpi,
    });
    const mp = this.options.multipart ?? {};
    const reference = this.nextConcatRef();
    const built = buildParts(opts.text, {
      reference,
      registry: this.registry,
      strategy: opts.strategy ?? mp.strategy ?? 'udh8',
      ...(opts.encoding ? { encoding: opts.encoding } : {}),
      ...(opts.shift ? { shift: opts.shift } : {}),
      ...(mp.shiftTables ? { shiftTables: mp.shiftTables } : {}),
      ...(mp.allowLatin1 !== undefined ? { allowLatin1: mp.allowLatin1 } : {}),
      ...(mp.packGsm7 !== undefined ? { packGsm7: mp.packGsm7 } : {}),
      ...(opts.params?.esm_class !== undefined ? { esmClass: opts.params.esm_class } : {}),
    });

    const maxSegments = opts.maxSegments ?? mp.maxSegments ?? 255;
    if (built.parts.length > maxSegments) {
      throw new SmppValidationError(
        `Text needs ${built.parts.length} segments, over maxSegments (${maxSegments})`,
        'text',
        COMMAND_STATUS.ESME_RINVMSGLEN,
      );
    }
    if (opts.flash) {
      const dataCoding = flashDataCoding(built.dataCoding);
      for (const part of built.parts) part.data_coding = dataCoding;
    }

    const registered =
      opts.registeredDelivery === true
        ? REGISTERED_DELIVERY.FINAL
        : opts.registeredDelivery === false || opts.registeredDelivery === undefined
          ? REGISTERED_DELIVERY.NONE
          : opts.registeredDelivery;

    const base: PduParams<'submit_sm'> = {
      service_type: opts.serviceType ?? '',
      source_addr_ton: source.ton,
      source_addr_npi: source.npi,
      source_addr: source.addr,
      dest_addr_ton: dest.ton,
      dest_addr_npi: dest.npi,
      destination_addr: dest.addr,
      registered_delivery: registered,
      priority_flag: opts.priority ?? 0,
      validity_period: toSmppTime(opts.validityPeriod),
      schedule_delivery_time: toSmppTime(opts.scheduleDeliveryTime),
      ...opts.params,
    };

    const results = await Promise.allSettled(
      built.parts.map((part) =>
        this.request(
          'submit_sm',
          { ...base, ...part },
          {
            ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
        ),
      ),
    );
    const failed = results.some((r) => r.status === 'rejected');
    if (failed) {
      if (results.length === 1 && results[0]?.status === 'rejected') throw results[0].reason;
      throw new SmppMultipartError(
        results.map((r) =>
          r.status === 'fulfilled' ? { messageId: r.value.message_id } : { error: toError(r.reason) },
        ),
      );
    }
    const messageIds = results.map(
      (r) => (r as PromiseFulfilledResult<ResponseOf<'submit_sm'>>).value.message_id,
    );
    // Track only when a final receipt is requested whatever the outcome (bits 0-1 = 01):
    // with "failure only" or "success only", a missing receipt proves nothing.
    const wantsReceipt = ((base.registered_delivery ?? 0) & 0x03) === REGISTERED_DELIVERY.FINAL;
    if (this.tracker && wantsReceipt) this.tracker.track(messageIds, opts.reference);
    return {
      messageIds,
      parts: built.parts.length,
      encoding: built.encoding.toUpperCase(),
    };
  }

  query(messageId: string, params: Omit<PduParams<'query_sm'>, 'message_id'> = {}, options?: RequestOptions) {
    return this.request('query_sm', { ...params, message_id: messageId }, options);
  }

  cancel(
    messageId: string,
    params: Omit<PduParams<'cancel_sm'>, 'message_id'> = {},
    options?: RequestOptions,
  ) {
    return this.request('cancel_sm', { ...params, message_id: messageId }, options);
  }

  replace(messageId: string, params: Omit<PduParams<'replace_sm'>, 'message_id'>, options?: RequestOptions) {
    return this.request('replace_sm', { ...params, message_id: messageId }, options);
  }

  /** Answers a deliver_sm / data_sm manually (with `autoAck: false`). */
  respond(pdu: DeliverSm | DataSm, params: { command_status?: number; message_id?: string } = {}): void {
    const session = this.session;
    if (!session) throw new SmppStateError('respond', 'CLOSED');
    session.respond(pdu, params);
  }

  // ---------------------------------------------------------------- receiving

  private onPdu(session: Session, pdu: Pdu): void {
    switch (pdu.command) {
      case 'deliver_sm':
        this.emitSafe('deliver', pdu);
        this.handleInbound(pdu);
        break;
      case 'data_sm':
        this.emitSafe('dataSm', pdu);
        this.handleInbound(pdu);
        break;
      case 'alert_notification':
        this.emitSafe('alert', pdu);
        return;
      default:
        if (responseNameOf(pdu.command)) {
          session.respond(pdu as { command: RequestCommandName; sequence_number: number }, {
            command_status: COMMAND_STATUS.ESME_RINVCMDID,
          });
        }
        return;
    }
    if (this.options.autoAck ?? true) session.respond(pdu, {});
  }

  private handleInbound(pdu: DeliverSm | DataSm): void {
    try {
      const content = decodeMessageContent(
        { ...pdu, short_message: 'short_message' in pdu ? pdu.short_message : undefined } as Parameters<
          typeof decodeMessageContent
        >[0],
        { registry: this.registry, packedGsm7: this.options.packedGsm7 ?? false },
      );
      if (isDeliveryReceipt(pdu)) {
        const dlr = buildDeliveryReport(pdu, content.text, this.options.messageIdFormat ?? 'as-is');
        if (dlr) {
          this.emitSafe('deliveryReport', dlr, pdu);
          this.tracker?.handle(dlr);
          return;
        }
      }
      if (content.concat) {
        const done = this.reassembler.add({
          source: pdu.source_addr,
          destination: pdu.destination_addr,
          concat: content.concat,
          body: content.body,
          dataCoding: pdu.data_coding,
          ...(content.udh?.shift ? { shift: content.udh.shift } : {}),
          meta: pdu,
        });
        if (done) this.emitSafe('message', toInbound(done));
        return;
      }
      const msg: InboundMessage = {
        from: pdu.source_addr,
        to: pdu.destination_addr,
        body: content.body,
        dataCoding: pdu.data_coding,
        parts: 1,
        missing: [],
        pdus: [pdu],
      };
      if (content.text !== undefined) msg.text = content.text;
      this.emitSafe('message', msg);
    } catch (err) {
      this.logger.error('failed to process inbound message', { error: toError(err).message });
    }
  }

  // ---------------------------------------------------------------- helpers

  private nextConcatRef(): number {
    this.concatRef = (this.concatRef + 1) & 0xffff;
    return this.concatRef;
  }

  private buildRaw(): RawApi {
    const raw: Record<string, unknown> = {};
    const excluded = new Set([
      'bind_transmitter',
      'bind_receiver',
      'bind_transceiver',
      'unbind',
      'outbind',
      'alert_notification',
      'deliver_sm',
    ]);
    for (const name of Object.keys(COMMANDS)) {
      if (excluded.has(name) || !responseNameOf(name as RequestCommandName)) continue;
      raw[name] = (params?: object, options?: RequestOptions) =>
        this.request(name as RawCommand, (params ?? {}) as never, options);
    }
    return raw as RawApi;
  }

  /** Exceptions thrown by user listeners must not break the session. */
  private emitSafe<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): void {
    try {
      (this.emit as (e: K, ...a: ClientEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.logger.error(`listener for "${String(event)}" threw`, { error: toError(err).message });
    }
  }

  private emitError(err: SmppError): void {
    // An unhandled `error` does not end the process: it goes to the logger.
    if (this.listenerCount('error') > 0) this.emitSafe('error', err);
    else this.logger.error(err.message, { code: err.code });
  }
}

function resolveEndpoint(o: SmppClientOptions): Endpoint {
  if (o.url) {
    const ep = parseSmppUrl(o.url);
    if (o.tls) ep.tls = true;
    return ep;
  }
  if (!o.host) throw new SmppError('SMPP_CONFIG', 'Either url or host is required');
  const tlsEnabled = Boolean(o.tls);
  return { host: o.host, port: o.port ?? (tlsEnabled ? 3550 : 2775), tls: tlsEnabled };
}

/** Waits `ms`, or rejects with `SmppAbortError` (nothing written) if the signal fires first. */
function abortableDelay(ms: number, signal: AbortSignal | undefined, command: string): Promise<void> {
  if (signal?.aborted) return Promise.reject(new SmppAbortError(false, command, { cause: signal.reason }));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SmppAbortError(false, command, { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * data_coding with message class 0 (flash), 3GPP TS 23.038 §4, general coding group:
 * bit 4 = class present, bits 3-2 = alphabet, bits 1-0 = class.
 */
function flashDataCoding(dataCoding: number): number {
  switch (dataCoding) {
    case 0x00: // SMSC default / GSM7
      return 0x10;
    case 0x04: // 8-bit binary
      return 0x14;
    case 0x08: // UCS2
      return 0x18;
    default:
      throw new SmppValidationError(
        `Flash SMS is not available with data_coding 0x${dataCoding.toString(16).padStart(2, '0')}`,
        'flash',
      );
  }
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function toSmppTime(value: Date | number | string | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatRelativeTime(value);
  return formatAbsoluteTime(value);
}

function toInbound(msg: ReassembledMessage<DeliverSm | DataSm>): InboundMessage {
  const out: InboundMessage = {
    from: msg.source,
    to: msg.destination,
    body: msg.body,
    dataCoding: msg.dataCoding,
    parts: msg.total,
    missing: msg.missing,
    pdus: msg.segments.map((s) => s.meta),
  };
  if (msg.text !== undefined) out.text = msg.text;
  return out;
}
