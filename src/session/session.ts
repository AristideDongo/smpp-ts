import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { Framer } from '../codec/framer.js';
import { type Pdu, type PduCodec, type PduOf, type PduParams, defaultCodec } from '../codec/pdu.js';
import {
  SmppConnectionClosedError,
  SmppDecodeError,
  SmppError,
  SmppStateError,
  SmppStatusError,
  SmppTimeoutError,
  SmppValidationError,
  toError,
} from '../errors.js';
import { type Logger, type RedactOptions, redactPdu, silentLogger } from '../logger.js';
import type { Metric } from '../metrics.js';
import {
  type CommandName,
  type RequestCommandName,
  type ResponseCommandName,
  isResponseCommand,
  responseNameOf,
} from '../protocol/commands.js';
import { MAX_SEQUENCE_NUMBER, RESPONSE_BIT } from '../protocol/constants.js';
import {
  COMMAND_STATUS,
  type StatusClassifier,
  defaultStatusClassifier,
  statusName,
} from '../protocol/status.js';
import type { TokenBucket } from './rate-limiter.js';
import {
  BIND_COMMANDS,
  BOUND_STATE,
  type BindMode,
  type SessionRole,
  type SessionState,
  StateMachine,
  canSend,
  isBound,
  peerRole,
} from './state-machine.js';
import { type PendingRequest, RequestQueue, createPendingRequest, expireRequest } from './window.js';

/** Réponse attendue pour une requête `C`. */
export type ResponseOf<C extends CommandName> = `${C}_resp` extends ResponseCommandName
  ? PduOf<`${C}_resp`>
  : never;

export interface SessionTimeouts {
  /** Timeout de chaque requête (file + attente de réponse). Défaut : 10 s. */
  requestTimeout?: number;
  /** Envoi d'un enquire_link après cette période sans trafic reçu. 0 = désactivé. Défaut : 30 s. */
  enquireLinkInterval?: number;
  /** Délai de réponse à un enquire_link avant de déclarer la session morte. Défaut : 10 s. */
  enquireLinkTimeout?: number;
  /** Attente de unbind_resp avant fermeture forcée. Défaut : 5 s. */
  unbindTimeout?: number;
  /** Fermeture d'une session bindée sans aucun trafic reçu. 0 = désactivé. Défaut : 0. */
  idleTimeout?: number;
}

export interface SessionOptions extends SessionTimeouts {
  role: SessionRole;
  codec?: PduCodec;
  logger?: Logger;
  redact?: RedactOptions;
  /** Nombre maximal de requêtes en vol (REL-03). Défaut : 10. */
  window?: number;
  /** File partagée (client : survit aux reconnexions). Sinon une file propre est créée. */
  queue?: RequestQueue;
  /** Taille de la file propre. Défaut : 10 000. */
  maxQueueSize?: number;
  rateLimiter?: TokenBucket;
  classifyStatus?: StatusClassifier;
  /** Identifiant de session pour les logs. */
  id?: string;
  /** Contexte ajouté à chaque log. */
  logContext?: Record<string, unknown>;
}

export interface RequestOptions {
  /** Timeout propre à cette requête. */
  timeout?: number;
}

export interface SessionEvents {
  /** Requête entrante non traitée automatiquement : le propriétaire doit y répondre. */
  pdu: [pdu: Pdu];
  stateChange: [from: SessionState, to: SessionState];
  close: [error: Error | undefined];
  error: [error: SmppError];
  metric: [metric: Metric];
}

/** Commandes qui ne consomment ni place dans la fenêtre ni jeton de débit. */
const CONTROL_COMMANDS = new Set<CommandName>([
  'bind_transmitter',
  'bind_receiver',
  'bind_transceiver',
  'unbind',
  'enquire_link',
  'outbind',
  'generic_nack',
]);

let sessionCounter = 0;

/**
 * Session SMPP sur un flux (socket TCP/TLS), commune au client et au serveur.
 * Gère : machine à états, découpage du flux, timeouts, fenêtre, file bornée, keepalive,
 * contre-pression et réponses automatiques (enquire_link, unbind, PDU invalides).
 */
export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly role: SessionRole;
  readonly codec: PduCodec;
  readonly logger: Logger;
  readonly queue: RequestQueue;
  /** Contexte libre (ex. résultat de l'authentification côté serveur). */
  context: unknown;
  /** system_id du pair, une fois bindé. */
  systemId: string | undefined;

  private readonly ownsQueue: boolean;
  private readonly machine: StateMachine;
  private readonly framer: Framer;
  private readonly inflight = new Map<number, PendingRequest>();
  private windowUsed = 0;
  private readonly window: number;
  private readonly redact: RedactOptions;
  private readonly classify: StatusClassifier;
  private readonly rateLimiter: TokenBucket | undefined;
  private readonly timeouts: Required<SessionTimeouts>;
  private readonly logContext: Record<string, unknown>;

  private sequence = 0;
  private writeBlocked = false;
  private paused = false;
  private pendingFrames: Buffer[] = [];
  private lastReceived = Date.now();
  private keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  private rateTimer: ReturnType<typeof setTimeout> | undefined;
  private enquirePending = false;
  private closeError: Error | undefined;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    readonly socket: Duplex & { remoteAddress?: string; remotePort?: number },
    options: SessionOptions,
  ) {
    super();
    this.id = options.id ?? `s${++sessionCounter}`;
    this.role = options.role;
    this.codec = options.codec ?? defaultCodec;
    this.logger = options.logger ?? silentLogger;
    this.redact = options.redact ?? {};
    this.window = Math.max(1, options.window ?? 10);
    this.ownsQueue = options.queue === undefined;
    this.queue = options.queue ?? new RequestQueue(options.maxQueueSize ?? 10_000);
    this.rateLimiter = options.rateLimiter;
    this.classify = options.classifyStatus ?? defaultStatusClassifier;
    this.timeouts = {
      requestTimeout: options.requestTimeout ?? 10_000,
      enquireLinkInterval: options.enquireLinkInterval ?? 30_000,
      enquireLinkTimeout: options.enquireLinkTimeout ?? 10_000,
      unbindTimeout: options.unbindTimeout ?? 5_000,
      idleTimeout: options.idleTimeout ?? 0,
    };
    this.logContext = {
      sessionId: this.id,
      remoteAddress: socket.remoteAddress,
      ...options.logContext,
    };
    this.framer = new Framer(this.codec.maxPduLength);
    this.closedPromise = new Promise((r) => {
      this.resolveClosed = r;
    });

    this.machine = new StateMachine('CLOSED', (from, to) => {
      this.log('debug', `state ${from} -> ${to}`);
      this.emit('stateChange', from, to);
    });
    this.machine.transition('OPEN');

    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('drain', () => {
      this.writeBlocked = false;
      this.dispatch();
    });
    socket.on('error', (err: Error) => {
      this.closeError ??= err;
      this.log('warn', 'socket error', { error: err.message });
    });
    socket.on('close', () => this.onClose());
    // Fin de flux côté pair : on termine proprement notre côté.
    socket.on('end', () => {
      if (!socket.destroyed) socket.end();
    });

    this.scheduleKeepalive();
  }

  // ---------------------------------------------------------------- accès

  get state(): SessionState {
    return this.machine.state;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }

  /** Requêtes en vol (hors contrôle). */
  get inflightCount(): number {
    return this.windowUsed;
  }

  /** Promise résolue à la fermeture du socket. */
  get closedSignal(): Promise<void> {
    return this.closedPromise;
  }

  // ---------------------------------------------------------------- envoi

  /**
   * Envoie une requête et attend sa réponse.
   * Rejette avec : `SmppStatusError`, `SmppTimeoutError`, `SmppConnectionClosedError`,
   * `SmppQueueFullError`, `SmppStateError` ou `SmppValidationError`. Jamais d'attente infinie.
   */
  request<C extends RequestCommandName>(
    command: C,
    params: PduParams<C> = {} as PduParams<C>,
    options: RequestOptions = {},
  ): Promise<ResponseOf<C>> {
    try {
      if (this.closed) throw new SmppConnectionClosedError(false, 'Session is closed');
      if (
        !canSend(this.role, this.state, command) &&
        !(this.state === 'OPEN' && !CONTROL_COMMANDS.has(command))
      ) {
        throw new SmppStateError(`send ${command}`, this.state, COMMAND_STATUS.ESME_RINVBNDSTS);
      }
      if (!responseNameOf(command)) {
        throw new SmppValidationError(`${command} has no response: use send()`, 'command');
      }
      const encoded = this.encode(command, params, 0);
      const timeoutMs = options.timeout ?? this.timeouts.requestTimeout;
      if (CONTROL_COMMANDS.has(command)) {
        return this.sendControl(command, encoded, timeoutMs) as Promise<ResponseOf<C>>;
      }
      const { request, promise } = createPendingRequest({
        command,
        encoded,
        timeoutMs,
        onTimeout: (req) => this.onRequestTimeout(req),
      });
      this.queue.push(request);
      this.emitMetric({ name: 'queue.size', type: 'gauge', value: this.queue.size });
      this.dispatch();
      return promise as Promise<ResponseOf<C>>;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Envoie une requête sans réponse (alert_notification, outbind). */
  send<C extends 'alert_notification' | 'outbind'>(
    command: C,
    params: PduParams<C> = {} as PduParams<C>,
  ): void {
    if (!canSend(this.role, this.state, command)) {
      throw new SmppStateError(`send ${command}`, this.state, COMMAND_STATUS.ESME_RINVBNDSTS);
    }
    this.write(this.encode(command, params, this.nextSequence()), command);
  }

  /** Répond à une requête reçue. `command_status` ≠ 0 pour une erreur. */
  respond<C extends RequestCommandName>(
    request: { command: C; sequence_number: number },
    params: PduParams<ResponseCommandName> & { command_status?: number } = {},
  ): void {
    const respName = responseNameOf(request.command);
    if (!respName) {
      throw new SmppValidationError(`${request.command} does not take a response`, 'command');
    }
    if (this.closed) return;
    const { command_status = 0, ...rest } = params;
    // Une réponse d'erreur peut omettre le corps (et le doit pour certains SMSC).
    const body = command_status !== 0 ? {} : rest;
    const buf = this.codec.encode({
      command: respName,
      command_status,
      sequence_number: request.sequence_number,
      ...body,
    } as never);
    this.write(buf, respName, command_status);
  }

  /** Envoie un generic_nack. */
  nack(sequenceNumber: number, status: number): void {
    if (this.closed) return;
    const buf = this.codec.encode({
      command: 'generic_nack',
      command_status: status,
      sequence_number: sequenceNumber,
    });
    this.write(buf, 'generic_nack', status);
  }

  // ---------------------------------------------------------------- bind / unbind / close

  /** Côté client : envoie le bind et passe dans l'état correspondant si le SMSC accepte. */
  async bind(
    mode: BindMode,
    params: PduParams<'bind_transceiver'>,
    timeout?: number,
  ): Promise<ResponseOf<'bind_transceiver'>> {
    if (this.role !== 'esme')
      throw new SmppStateError('bind', this.state, COMMAND_STATUS.ESME_RINVBNDSTS, 'Only an ESME can bind');
    const command = BIND_COMMANDS[mode];
    const resp = (await this.sendControl(
      command,
      this.encode(command, params, 0),
      timeout ?? this.timeouts.requestTimeout,
      'bind',
    )) as ResponseOf<'bind_transceiver'>;
    this.markBound(mode, resp.system_id);
    return resp;
  }

  /** Passe la session dans l'état bindé (serveur : après authentification). */
  markBound(mode: BindMode, systemId?: string): void {
    this.machine.transition(BOUND_STATE[mode]);
    if (systemId !== undefined) {
      this.systemId = systemId;
      this.logContext.systemId = systemId;
    }
    this.lastReceived = Date.now();
    this.scheduleKeepalive();
    this.dispatch();
  }

  /** Envoie unbind et attend unbind_resp (avec timeout). N'échoue jamais. */
  async unbind(): Promise<void> {
    if (!isBound(this.state)) return;
    const encoded = this.encode('unbind', {}, 0);
    const pending = this.sendControl('unbind', encoded, this.timeouts.unbindTimeout, 'unbind');
    this.machine.transition('UNBOUND');
    try {
      await pending;
    } catch (err) {
      this.log('debug', 'unbind did not complete cleanly', { error: toError(err).message });
    }
  }

  /** Fermeture propre : unbind si bindé, puis fermeture du socket. */
  async close(): Promise<void> {
    if (this.closed) return this.closedPromise;
    await this.unbind();
    this.endSocket();
    return this.closedPromise;
  }

  /** Fermeture immédiate. */
  destroy(error?: Error): void {
    if (error) this.closeError ??= error;
    this.socket.destroy();
  }

  /** Suspend le traitement des PDU entrants (REL-09). */
  pause(): void {
    this.paused = true;
    this.socket.pause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    for (let i = 0; i < frames.length; i++) {
      if (this.paused) {
        this.pendingFrames = frames.slice(i).concat(this.pendingFrames);
        return;
      }
      this.handleFrame(frames[i]!);
    }
    if (!this.paused) this.socket.resume();
  }

  // ---------------------------------------------------------------- interne : envoi

  private encode(command: CommandName, params: object, sequence: number): Buffer {
    return this.codec.encode({ ...params, command, sequence_number: sequence } as never);
  }

  private nextSequence(): number {
    for (let i = 0; i < 1000; i++) {
      this.sequence = this.sequence >= MAX_SEQUENCE_NUMBER ? 1 : this.sequence + 1;
      if (!this.inflight.has(this.sequence)) return this.sequence;
    }
    return this.sequence;
  }

  private sendControl(
    command: CommandName,
    encoded: Buffer,
    timeoutMs: number,
    kind: 'bind' | 'unbind' | 'request' = 'request',
  ): Promise<Pdu> {
    if (this.closed) return Promise.reject(new SmppConnectionClosedError(false, 'Session is closed'));
    const { request, promise } = createPendingRequest({
      command,
      encoded,
      timeoutMs,
      control: true,
      onTimeout: (req) => this.onRequestTimeout(req),
    });
    this.writeRequest(request);
    if (kind === 'request') return promise;
    // Requalifie le timeout en timeout de bind/unbind.
    return promise.catch((err: unknown) => {
      if (err instanceof SmppTimeoutError)
        throw new SmppTimeoutError(kind, err.timeoutMs, command, err.written);
      throw err;
    });
  }

  private writeRequest(req: PendingRequest): void {
    const seq = this.nextSequence();
    req.encoded.writeUInt32BE(seq, 12);
    req.sequence = seq;
    req.phase = 'inflight';
    this.inflight.set(seq, req);
    if (!req.control) this.windowUsed++;
    req.release = () => {
      if (this.inflight.get(seq) === req) {
        this.inflight.delete(seq);
        if (!req.control) this.windowUsed--;
      }
    };
    req.writtenAt = Date.now();
    req.written = true;
    this.write(req.encoded, req.command);
    if (!req.control) this.emitMetric({ name: 'request.inflight', type: 'gauge', value: this.windowUsed });
  }

  /** Remplit la fenêtre depuis la file, en respectant l'état, la contre-pression et le débit. */
  dispatch(): void {
    if (this.closed || this.writeBlocked || !isBound(this.state)) return;
    while (this.windowUsed < this.window) {
      const req = this.queue.peek();
      if (!req) break;
      // Échéance (presque) atteinte : ne jamais écrire un PDU qu'on abandonnerait aussitôt (risque de doublon).
      // Marge : 10 % du timeout, 50 ms au plus.
      if (req.deadline - Date.now() <= Math.min(50, req.timeoutMs / 10)) {
        this.queue.shift();
        expireRequest(req);
        this.emitMetric({
          name: 'request.timeout',
          type: 'counter',
          value: 1,
          labels: { command: req.command },
        });
        continue;
      }
      if (!canSend(this.role, this.state, req.command)) {
        this.queue.shift();
        req.reject(new SmppStateError(`send ${req.command}`, this.state, COMMAND_STATUS.ESME_RINVBNDSTS));
        continue;
      }
      if (this.rateLimiter) {
        const wait = this.rateLimiter.take();
        if (wait > 0) {
          if (!this.rateTimer) {
            this.rateTimer = setTimeout(() => {
              this.rateTimer = undefined;
              this.dispatch();
            }, wait);
            this.rateTimer.unref?.();
          }
          break;
        }
      }
      this.queue.shift();
      this.writeRequest(req);
      if (this.writeBlocked) break;
    }
    this.emitMetric({ name: 'queue.size', type: 'gauge', value: this.queue.size });
  }

  private write(buf: Buffer, command: CommandName, status = 0): void {
    if (this.closed || this.socket.destroyed) return;
    this.logPdu('sent', buf);
    const ok = this.socket.write(buf);
    if (!ok) this.writeBlocked = true;
    this.emitMetric({ name: 'pdu.sent', type: 'counter', value: 1, labels: { command } });
    this.emitMetric({ name: 'bytes.out', type: 'counter', value: buf.length });
    if (isResponseCommand(command) && status !== 0) {
      this.emitMetric({
        name: 'command_status',
        type: 'counter',
        value: 1,
        labels: { command, status: statusName(status) },
      });
    }
  }

  private onRequestTimeout(req: PendingRequest): void {
    this.emitMetric({ name: 'request.timeout', type: 'counter', value: 1, labels: { command: req.command } });
    this.log('warn', `${req.command} timed out`, { sequence_number: req.sequence, written: req.written });
    this.dispatch();
  }

  // ---------------------------------------------------------------- interne : réception

  private onData(chunk: Buffer): void {
    this.lastReceived = Date.now();
    this.emitMetric({ name: 'bytes.in', type: 'counter', value: chunk.length });
    const { frames, error } = this.framer.push(chunk);
    for (const frame of frames) {
      if (this.paused) this.pendingFrames.push(frame);
      else this.handleFrame(frame);
    }
    if (error) {
      // Flux désynchronisé : impossible de retrouver la frontière du PDU suivant (BUG-08).
      this.log('error', 'unrecoverable framing error, closing session', { error: error.message });
      this.nack(0, error.status);
      this.emitError(error);
      this.endSocket();
    }
  }

  private handleFrame(frame: Buffer): void {
    let pdu: Pdu;
    try {
      pdu = this.codec.decode(frame);
    } catch (err) {
      this.onDecodeError(err);
      return;
    }
    this.logPdu('received', pdu);
    this.emitMetric({ name: 'pdu.received', type: 'counter', value: 1, labels: { command: pdu.command } });
    try {
      if (isResponseCommand(pdu.command)) this.handleResponse(pdu);
      else this.handleRequest(pdu);
    } catch (err) {
      // Une erreur dans un listener ne doit jamais casser la session.
      this.log('error', 'error while handling PDU', { command: pdu.command, error: toError(err).message });
      this.emitError(
        err instanceof SmppError ? err : new SmppError('SMPP_HANDLER', toError(err).message, { cause: err }),
      );
    }
  }

  private onDecodeError(err: unknown): void {
    const e =
      err instanceof SmppDecodeError
        ? err
        : new SmppDecodeError(COMMAND_STATUS.ESME_RSYSERR, 'Unexpected decode failure', { cause: err });
    const header = e.header;
    this.log('warn', 'invalid PDU received', {
      error: e.message,
      status: statusName(e.status),
      sequence_number: header?.sequence_number,
    });
    if (header && (header.command_id & RESPONSE_BIT) !== 0) {
      // Réponse illisible : on rejette la requête correspondante, sans nack.
      const req = this.inflight.get(header.sequence_number);
      req?.reject(e);
      this.dispatch();
      return;
    }
    // Requête illisible : generic_nack et la session continue (BUG-08).
    this.nack(header?.sequence_number ?? 0, e.status);
  }

  private handleResponse(pdu: Pdu): void {
    const req = this.inflight.get(pdu.sequence_number);
    if (!req) {
      this.log('debug', 'response without matching request (late or unknown)', {
        command: pdu.command,
        sequence_number: pdu.sequence_number,
      });
      return;
    }
    const expected = responseNameOf(req.command);
    if (req.writtenAt !== undefined) {
      this.emitMetric({
        name: 'request.latency',
        type: 'histogram',
        value: Date.now() - req.writtenAt,
        labels: { command: req.command },
      });
    }
    if (pdu.command_status !== 0) {
      this.emitMetric({
        name: 'command_status',
        type: 'counter',
        value: 1,
        labels: { command: req.command, status: statusName(pdu.command_status) },
      });
      const err = new SmppStatusError(req.command, pdu.command_status, this.classify(pdu.command_status));
      if (
        this.rateLimiter &&
        err.category === 'temporary' &&
        (pdu.command_status === COMMAND_STATUS.ESME_RTHROTTLED ||
          pdu.command_status === COMMAND_STATUS.ESME_RMSGQFUL)
      ) {
        this.rateLimiter.penalize();
      }
      req.reject(err);
    } else if (pdu.command !== expected) {
      req.reject(
        new SmppDecodeError(
          COMMAND_STATUS.ESME_RINVCMDID,
          `Expected ${expected} but received ${pdu.command}`,
        ),
      );
    } else {
      req.resolve(pdu);
    }
    this.dispatch();
  }

  private handleRequest(pdu: Pdu): void {
    if (!canSend(peerRole(this.role), this.state, pdu.command)) {
      // Commande interdite dans cet état ou ce mode de bind (SEC-06, SEC-07).
      const status =
        pdu.command.startsWith('bind_') && isBound(this.state)
          ? COMMAND_STATUS.ESME_RALYBND
          : COMMAND_STATUS.ESME_RINVBNDSTS;
      this.log('warn', `${pdu.command} not allowed in state ${this.state}`, {
        sequence_number: pdu.sequence_number,
      });
      if (responseNameOf(pdu.command))
        this.respond(pdu as { command: RequestCommandName; sequence_number: number }, {
          command_status: status,
        });
      else this.nack(pdu.sequence_number, status);
      return;
    }
    switch (pdu.command) {
      case 'enquire_link':
        this.respond(pdu);
        return;
      case 'unbind':
        this.respond(pdu);
        this.machine.transition('UNBOUND');
        this.endSocket();
        return;
      default:
        if (this.listenerCount('pdu') === 0) {
          if (responseNameOf(pdu.command)) {
            this.respond(pdu as { command: RequestCommandName; sequence_number: number }, {
              command_status: COMMAND_STATUS.ESME_RSYSERR,
            });
          }
          return;
        }
        this.emit('pdu', pdu);
    }
  }

  // ---------------------------------------------------------------- keepalive

  private scheduleKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    if (this.closed || !isBound(this.state)) return;
    const { enquireLinkInterval, idleTimeout } = this.timeouts;
    const periods = [enquireLinkInterval, idleTimeout].filter((p) => p > 0);
    if (periods.length === 0) return;
    const elapsed = Date.now() - this.lastReceived;
    const delay = Math.max(10, Math.min(...periods.map((p) => p - elapsed)));
    this.keepaliveTimer = setTimeout(() => this.onKeepaliveTimer(), delay);
    this.keepaliveTimer.unref?.();
  }

  private onKeepaliveTimer(): void {
    this.keepaliveTimer = undefined;
    if (this.closed || !isBound(this.state)) return;
    const { enquireLinkInterval, enquireLinkTimeout, idleTimeout } = this.timeouts;
    const idle = Date.now() - this.lastReceived;
    if (idleTimeout > 0 && idle >= idleTimeout) {
      this.log('warn', 'idle timeout, closing session');
      this.destroy(new SmppTimeoutError('request', idleTimeout, 'idle session'));
      return;
    }
    if (enquireLinkInterval > 0 && idle >= enquireLinkInterval && !this.enquirePending) {
      this.enquirePending = true;
      const encoded = this.encode('enquire_link', {}, 0);
      this.sendControl('enquire_link', encoded, enquireLinkTimeout)
        .then(() => {
          this.enquirePending = false;
        })
        .catch((err: unknown) => {
          this.enquirePending = false;
          if (err instanceof SmppTimeoutError) {
            // Connexion à moitié ouverte : la session est déclarée morte (BUG-07).
            const dead = new SmppTimeoutError(
              'enquire_link',
              enquireLinkTimeout,
              'enquire_link response',
              true,
            );
            this.log('error', 'no enquire_link_resp, session considered dead');
            this.emitError(dead);
            this.destroy(dead);
          }
        });
    }
    this.scheduleKeepalive();
  }

  // ---------------------------------------------------------------- fermeture

  private endSocket(): void {
    if (this.socket.destroyed) return;
    this.socket.end();
    // Le pair peut ne jamais fermer : fermeture forcée après unbindTimeout.
    const t = setTimeout(() => this.socket.destroy(), this.timeouts.unbindTimeout);
    t.unref?.();
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.rateTimer) clearTimeout(this.rateTimer);
    const cause = this.closeError;
    // BUG-02 : toutes les requêtes en vol sont rejetées, avec l'indication « écrite ».
    for (const req of [...this.inflight.values()]) {
      req.reject(new SmppConnectionClosedError(true, 'Connection closed before response', { cause }));
    }
    this.inflight.clear();
    this.windowUsed = 0;
    if (this.ownsQueue) {
      this.queue.rejectAll(
        () => new SmppConnectionClosedError(false, 'Connection closed before sending', { cause }),
      );
    }
    this.pendingFrames = [];
    if (this.machine.state !== 'CLOSED') this.machine.transition('CLOSED');
    this.log('info', 'session closed', cause ? { error: cause.message } : undefined);
    this.emit('close', cause);
    this.resolveClosed();
  }

  // ---------------------------------------------------------------- observabilité

  /** Émet `error` si quelqu'un écoute, sinon journalise : jamais de crash du processus. */
  emitError(err: SmppError): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.log('error', err.message, { code: err.code });
  }

  private emitMetric(metric: Metric): void {
    if (this.listenerCount('metric') > 0) this.emit('metric', metric);
  }

  log(level: keyof Logger, msg: string, meta?: Record<string, unknown>): void {
    try {
      this.logger[level](msg, { ...this.logContext, ...meta });
    } catch {
      // un logger défaillant ne doit pas casser la session
    }
  }

  private logPdu(direction: 'sent' | 'received', pdu: Pdu | Buffer): void {
    if (this.logger === silentLogger) return;
    let obj: Pdu | undefined;
    if (Buffer.isBuffer(pdu)) {
      try {
        obj = this.codec.decode(pdu);
      } catch {
        return;
      }
    } else {
      obj = pdu;
    }
    this.log('debug', `pdu ${direction}`, {
      command: obj.command,
      sequence_number: obj.sequence_number,
      pdu: redactPdu(obj, this.redact),
    });
  }
}
