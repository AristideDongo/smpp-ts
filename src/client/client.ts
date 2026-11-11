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
  SmppConnectionClosedError,
  SmppError,
  SmppMultipartError,
  SmppStateError,
  SmppStatusError,
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
  /** Défaut : 0x34 (SMPP v3.4, le plus largement accepté). 0x50 pour v5.0. */
  interface_version?: number;
  addr_ton?: number;
  addr_npi?: number;
  address_range?: string;
}

export interface SmppClientOptions {
  /** `smpp://hôte:port` ou `ssmpp://hôte:port` (TLS). */
  url?: string;
  host?: string;
  port?: number;
  /** Active TLS (et/ou fournit ses options). Vérification du certificat activée par défaut. */
  tls?: boolean | TlsClientOptions;
  bind: BindOptions;

  /** Requêtes en vol simultanées. Défaut : 10. */
  window?: number;
  /** Taille de la file d'envoi. Défaut : 10 000. */
  maxQueueSize?: number;
  rateLimit?: RateLimitOptions;
  /** Reconnexion automatique. Défaut : activée, tentatives illimitées. */
  reconnect?: boolean | ReconnectOptions;
  /** Nouvelles tentatives sur statut temporaire. `false` pour désactiver. */
  retry?: false | RetryOptions;
  /** Classification des command_status (REL-06). */
  classifyStatus?: (status: number, defaultCategory: StatusCategory) => StatusCategory;

  connectTimeout?: number;
  bindTimeout?: number;
  requestTimeout?: number;
  enquireLinkInterval?: number;
  enquireLinkTimeout?: number;
  unbindTimeout?: number;

  logger?: Logger;
  /** Masque le contenu des SMS dans les logs. */
  redactContent?: boolean;
  /** Masque partiellement les numéros dans les logs. */
  redactNumbers?: boolean;

  /** Répond automatiquement deliver_sm_resp / data_sm_resp (statut 0). Défaut : true. */
  autoAck?: boolean;
  /** Normalisation des message_id des accusés. Défaut : `as-is`. */
  messageIdFormat?: MessageIdFormat;
  /** Normalisation et validation des adresses de `sendText` (numéros, expéditeur alphanumérique). */
  address?: AddressOptions;
  /**
   * Regroupe les accusés des segments d'un message envoyé par `sendText` (avec `registeredDelivery`)
   * et émet `messageStatus` avec l'issue globale. Désactivé par défaut.
   */
  trackDeliveries?: boolean | DeliveryTrackerOptions;
  multipart?: {
    strategy?: MultipartStrategy;
    /** Tables de shift nationales autorisées pour la détection automatique. */
    shiftTables?: NationalLanguage[];
    allowLatin1?: boolean;
    packGsm7?: boolean;
  };
  reassembly?: { ttl?: number; maxBuffers?: number };
  /** Septets GSM7 entrants compactés. Défaut : false. */
  packedGsm7?: boolean;
  encodings?: EncodingRegistry;
  codec?: CodecOptions;
}

export interface SendTextOptions {
  to: string;
  from: string;
  text: string;
  /** Encodage forcé (`gsm7`, `latin1`, `ucs2`, `ascii` ou encodage enregistré). */
  encoding?: string;
  shift?: NationalLanguage;
  strategy?: MultipartStrategy;
  /** `true` = accusé sur l'issue finale ; ou une valeur registered_delivery. */
  registeredDelivery?: boolean | number;
  /** Date d'expiration absolue, durée en ms, ou chaîne SMPP. */
  validityPeriod?: Date | number | string;
  scheduleDeliveryTime?: Date | number | string;
  serviceType?: string;
  sourceTon?: number;
  sourceNpi?: number;
  destTon?: number;
  destNpi?: number;
  priority?: number;
  /** Paramètres submit_sm supplémentaires (TLV…). */
  params?: PduParams<'submit_sm'>;
  timeout?: number;
  /** Référence applicative renvoyée dans l'événement `messageStatus` (avec `trackDeliveries`). */
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
  /** Texte, ou `undefined` pour un contenu binaire. */
  text?: string;
  body: Buffer;
  dataCoding: number;
  parts: number;
  /** Segments manquants (partialMessage uniquement). */
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
  /** Issue globale d'un message suivi (option `trackDeliveries`). */
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

/** Raccourcis bas niveau : `client.raw.submit_sm({...})`. */
export type RawApi = {
  [C in RawCommand]: (params?: PduParams<C>, options?: RequestOptions) => Promise<ResponseOf<C>>;
};

/** Client SMPP (ESME). */
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

  /** Messages en attente d'accusés (option `trackDeliveries`). */
  get trackedMessages(): number {
    return this.tracker?.size ?? 0;
  }

  // ---------------------------------------------------------------- état

  get state(): SessionState {
    return this.session?.state ?? 'CLOSED';
  }

  get isBound(): boolean {
    const s = this.state;
    return s === 'BOUND_TX' || s === 'BOUND_RX' || s === 'BOUND_TRX';
  }

  /** Requêtes en file (pas encore écrites). */
  get queueSize(): number {
    return this.queue.size;
  }

  /** Requêtes en vol. */
  get inflight(): number {
    return this.session?.inflightCount ?? 0;
  }

  // ---------------------------------------------------------------- connexion

  /**
   * Se connecte et se binde. Rejette si la première tentative échoue ;
   * la reconnexion automatique prend ensuite le relais en cas de coupure.
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
      ...pick(o, ['requestTimeout', 'enquireLinkInterval', 'enquireLinkTimeout', 'unbindTimeout']),
      logContext: { systemId: o.bind.system_id, host: this.endpoint.host },
    });
    this.session = session;
    session.on('stateChange', (from, to) => this.emitSafe('stateChange', from, to));
    // La transition CLOSED → OPEN a lieu dans le constructeur de la session : on la relaie ici.
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
    // Les messages jamais écrits peuvent être renvoyés sans risque de doublon.
    this.queue.rejectAll(
      () => new SmppConnectionClosedError(false, 'Client closed before sending', { cause }),
    );
    this.reassembler.clear();
    this.tracker?.clear();
    this.emitSafe('close');
  }

  /**
   * Arrêt gracieux (REL-07).
   * `drain: true` : refuse les nouveaux envois, attend la fin des requêtes en file et en vol
   * (au plus `timeout`, défaut `requestTimeout`), puis unbind et fermeture.
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

  // ---------------------------------------------------------------- envoi

  /**
   * Envoie n'importe quelle requête SMPP et attend sa réponse.
   * Les statuts temporaires sont retentés avec backoff (cf. `retry`).
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
        await new Promise((r) => setTimeout(r, delay));
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
    // SEC-07 : refus local d'une commande interdite par le mode de bind.
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
    // Reconnexion en cours : la requête attend en file et partira après le re-bind (REL-05).
    try {
      const encoded = this.codec.encode({ ...params, command, sequence_number: 0 } as never);
      const timeoutMs = options.timeout ?? this.options.requestTimeout ?? 10_000;
      const { request, promise } = createPendingRequest({ command, encoded, timeoutMs });
      this.queue.push(request);
      return promise as Promise<ResponseOf<C>>;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Envoi bas niveau d'un submit_sm. */
  submit(params: PduParams<'submit_sm'>, options?: RequestOptions): Promise<ResponseOf<'submit_sm'>> {
    return this.request('submit_sm', params, options);
  }

  /**
   * Envoie un texte : choix automatique de l'encodage, découpage en segments,
   * renvoie tous les message_id.
   */
  async sendText(opts: SendTextOptions): Promise<SendTextResult> {
    // Adresses validées avant tout calcul : aucune requête n'est émise pour un message invalide.
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
          opts.timeout !== undefined ? { timeout: opts.timeout } : {},
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
    // Suivi uniquement si un accusé final est demandé quel que soit le résultat (bits 0-1 = 01) :
    // avec « échec seulement » ou « succès seulement », l'absence d'accusé ne permet pas de conclure.
    const wantsReceipt = ((base.registered_delivery ?? 0) & 0x03) === REGISTERED_DELIVERY.FINAL;
    if (this.tracker && wantsReceipt) this.tracker.track(messageIds, opts.reference);
    return {
      messageIds,
      parts: built.parts.length,
      encoding: built.encoding.toUpperCase(),
    };
  }

  /** query_sm. */
  query(messageId: string, params: Omit<PduParams<'query_sm'>, 'message_id'> = {}, options?: RequestOptions) {
    return this.request('query_sm', { ...params, message_id: messageId }, options);
  }

  /** cancel_sm. */
  cancel(
    messageId: string,
    params: Omit<PduParams<'cancel_sm'>, 'message_id'> = {},
    options?: RequestOptions,
  ) {
    return this.request('cancel_sm', { ...params, message_id: messageId }, options);
  }

  /** replace_sm. */
  replace(messageId: string, params: Omit<PduParams<'replace_sm'>, 'message_id'>, options?: RequestOptions) {
    return this.request('replace_sm', { ...params, message_id: messageId }, options);
  }

  /** Répond manuellement à un deliver_sm / data_sm (avec `autoAck: false`). */
  respond(pdu: DeliverSm | DataSm, params: { command_status?: number; message_id?: string } = {}): void {
    const session = this.session;
    if (!session) throw new SmppStateError('respond', 'CLOSED');
    session.respond(pdu, params);
  }

  // ---------------------------------------------------------------- réception

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

  // ---------------------------------------------------------------- utilitaires

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

  /** Les exceptions des listeners utilisateur ne doivent pas casser la session. */
  private emitSafe<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): void {
    try {
      (this.emit as (e: K, ...a: ClientEvents[K]) => boolean)(event, ...args);
    } catch (err) {
      this.logger.error(`listener for "${String(event)}" threw`, { error: toError(err).message });
    }
  }

  private emitError(err: SmppError): void {
    // Un `error` non écouté ne termine pas le processus : il part au logger (§8.3).
    if (this.listenerCount('error') > 0) this.emitSafe('error', err);
    else this.logger.error(err.message, { code: err.code });
  }
}

// ---------------------------------------------------------------- helpers

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
