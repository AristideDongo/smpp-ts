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

/** Expected response for a request `C`. */
export type ResponseOf<C extends CommandName> = `${C}_resp` extends ResponseCommandName
  ? PduOf<`${C}_resp`>
  : never;

export interface SessionTimeouts {
  /** Timeout of each request (queue time + response wait). Default: 10 s. */
  requestTimeout?: number;
  /** Sends an enquire_link after this period without incoming traffic. 0 = disabled. Default: 30 s. */
  enquireLinkInterval?: number;
  /** Time to wait for an enquire_link response before declaring the session dead. Default: 10 s. */
  enquireLinkTimeout?: number;
  /** Time to wait for unbind_resp before forcing the socket closed. Default: 5 s. */
  unbindTimeout?: number;
  /** Closes a bound session that receives no traffic. 0 = disabled. Default: 0. */
  idleTimeout?: number;
}

export interface SessionOptions extends SessionTimeouts {
  role: SessionRole;
  codec?: PduCodec;
  logger?: Logger;
  redact?: RedactOptions;
  /** Maximum number of in-flight requests (REL-03). Default: 10. */
  window?: number;
  /** Shared queue (client: survives reconnections). Otherwise the session creates its own. */
  queue?: RequestQueue;
  /** Size of the session's own queue. Default: 10 000. */
  maxQueueSize?: number;
  rateLimiter?: TokenBucket;
  classifyStatus?: StatusClassifier;
  /** Session identifier used in logs. */
  id?: string;
  /**
   * Source of `sequence_number` values (1 to 0x7FFFFFFF). Default: a counter starting at 1 in each session.
   * Values in flight are skipped automatically.
   */
  sequenceGenerator?: SequenceGenerator;
  /** Context added to every log entry. */
  logContext?: Record<string, unknown>;
  /**
   * Bytes waiting in the socket write buffer beyond which the session is closed:
   * a peer that sends requests without reading the responses cannot grow memory without limit.
   * Default: 1 MiB. 0 = no limit (reading is still paused while the buffer is full).
   */
  maxWriteBuffer?: number;
}

/**
 * Pluggable `sequence_number` source, e.g. to keep numbering going across restarts.
 * Called synchronously for every PDU sent: persist asynchronously (or by blocks) on your side.
 */
export interface SequenceGenerator {
  next(): number;
}

export interface RequestOptions {
  /** Timeout for this request only. */
  timeout?: number;
  /**
   * Cancels the request. Aborted before it is written: rejected with `SmppAbortError` (`written: false`),
   * safe to resend. Aborted while waiting for the response: rejected with `written: true`.
   */
  signal?: AbortSignal;
}

export interface SessionEvents {
  /** Incoming request not handled automatically: the owner must answer it. */
  pdu: [pdu: Pdu];
  stateChange: [from: SessionState, to: SessionState];
  close: [error: Error | undefined];
  error: [error: SmppError];
  metric: [metric: Metric];
}

/** Commands that use neither a window slot nor a rate-limit token. */
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
 * SMPP session over a stream (TCP/TLS socket), shared by client and server.
 * Handles the state machine, stream framing, timeouts, window, bounded queue, keepalive,
 * backpressure and automatic responses (enquire_link, unbind, invalid PDUs).
 */
export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly role: SessionRole;
  readonly codec: PduCodec;
  readonly logger: Logger;
  readonly queue: RequestQueue;
  /** Free-form context (e.g. the server-side authentication result). */
  context: unknown;
  /** Peer system_id, once bound. */
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
  private readonly maxWriteBuffer: number;

  private sequence = 0;
  private readonly sequenceGenerator: SequenceGenerator | undefined;
  /** The socket write buffer is full: no new request is written and reading is paused (REL-09). */
  private writeBlocked = false;
  /** Paused by the owner (asynchronous bind, inbound window). */
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
    this.maxWriteBuffer = options.maxWriteBuffer ?? 1024 * 1024;
    this.sequenceGenerator = options.sequenceGenerator;
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
      this.flushInput();
    });
    socket.on('error', (err: Error) => {
      this.closeError ??= err;
      this.log('warn', 'socket error', { error: err.message });
    });
    socket.on('close', () => this.onClose());
    // The peer ended its side of the stream: end ours cleanly.
    socket.on('end', () => {
      if (!socket.destroyed) socket.end();
    });

    this.scheduleKeepalive();
  }

  // ---------------------------------------------------------------- accessors

  get state(): SessionState {
    return this.machine.state;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress;
  }

  /** In-flight requests (control commands excluded). */
  get inflightCount(): number {
    return this.windowUsed;
  }

  /** Resolves when the socket is closed. */
  get closedSignal(): Promise<void> {
    return this.closedPromise;
  }

  // ---------------------------------------------------------------- sending

  /**
   * Sends a request and waits for its response.
   * Rejects with `SmppStatusError`, `SmppTimeoutError`, `SmppConnectionClosedError`,
   * `SmppQueueFullError`, `SmppStateError` or `SmppValidationError`. Never waits forever.
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
        signal: options.signal,
        onAbort: () => this.dispatch(),
      });
      this.queue.push(request);
      this.emitMetric({ name: 'queue.size', type: 'gauge', value: this.queue.size });
      this.dispatch();
      return promise as Promise<ResponseOf<C>>;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Sends a request that has no response (alert_notification, outbind). */
  send<C extends 'alert_notification' | 'outbind'>(
    command: C,
    params: PduParams<C> = {} as PduParams<C>,
  ): void {
    if (!canSend(this.role, this.state, command)) {
      throw new SmppStateError(`send ${command}`, this.state, COMMAND_STATUS.ESME_RINVBNDSTS);
    }
    this.write(this.encode(command, params, this.nextSequence()), command);
  }

  /** Answers a received request. Non-zero `command_status` for an error. */
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
    // An error response may omit the body (and must, for some SMSCs).
    const body = command_status !== 0 ? {} : rest;
    const buf = this.codec.encode({
      command: respName,
      command_status,
      sequence_number: request.sequence_number,
      ...body,
    } as never);
    this.write(buf, respName, command_status);
  }

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

  /** Client side: sends the bind and enters the matching state if the SMSC accepts it. */
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

  /** Enters the bound state (server: after authentication). */
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

  /** Sends unbind and waits for unbind_resp (with a timeout). Never throws. */
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

  /** Graceful close: unbind if bound, then close the socket. */
  async close(): Promise<void> {
    if (this.closed) return this.closedPromise;
    await this.unbind();
    this.endSocket();
    return this.closedPromise;
  }

  /** Immediate close. */
  destroy(error?: Error): void {
    if (error) this.closeError ??= error;
    this.socket.destroy();
  }

  /** Suspends processing of incoming PDUs (REL-09). */
  pause(): void {
    this.paused = true;
    this.socket.pause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.flushInput();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Incoming PDUs wait while the owner paused the session or the write buffer is full. */
  private get inputHeld(): boolean {
    return this.paused || this.writeBlocked;
  }

  /** Handles the frames held back, then resumes reading if nothing holds the input any more. */
  private flushInput(): void {
    if (this.closed) return;
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    for (let i = 0; i < frames.length; i++) {
      if (this.inputHeld) {
        this.pendingFrames = frames.slice(i).concat(this.pendingFrames);
        return;
      }
      this.handleFrame(frames[i]!);
    }
    if (!this.inputHeld) this.socket.resume();
  }

  // ---------------------------------------------------------------- internal: sending

  private encode(command: CommandName, params: object, sequence: number): Buffer {
    return this.codec.encode({ ...params, command, sequence_number: sequence } as never);
  }

  private nextSequence(): number {
    for (let i = 0; i < 1000; i++) {
      if (this.sequenceGenerator) {
        const value = Math.trunc(Number(this.sequenceGenerator.next()));
        // Out of range: wrap into 1..MAX_SEQUENCE_NUMBER rather than writing an invalid PDU.
        this.sequence =
          value >= 1 && value <= MAX_SEQUENCE_NUMBER ? value : (Math.abs(value) % MAX_SEQUENCE_NUMBER) + 1;
      } else {
        this.sequence = this.sequence >= MAX_SEQUENCE_NUMBER ? 1 : this.sequence + 1;
      }
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
    // Report the timeout as a bind/unbind timeout.
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

  /** Fills the window from the queue, honouring state, backpressure and rate limit. */
  dispatch(): void {
    if (this.closed || this.writeBlocked || !isBound(this.state)) return;
    while (this.windowUsed < this.window) {
      const req = this.queue.peek();
      if (!req) break;
      // Deadline (almost) reached: never write a PDU we would abandon right away (duplicate risk).
      // Margin: 10% of the timeout, at most 50 ms.
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
    if (!ok && !this.writeBlocked) {
      // Backpressure (REL-09): stop reading until the peer reads what we wrote, otherwise a peer
      // that never reads its responses makes us buffer them in memory.
      this.writeBlocked = true;
      this.socket.pause();
    }
    const buffered = this.socket.writableLength;
    if (this.maxWriteBuffer > 0 && buffered > this.maxWriteBuffer) {
      this.log('error', 'write buffer limit exceeded, closing session', {
        writableLength: buffered,
        maxWriteBuffer: this.maxWriteBuffer,
      });
      this.destroy(new SmppError('SMPP_WRITE_BUFFER', `Write buffer over ${this.maxWriteBuffer} bytes`));
    }
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

  // ---------------------------------------------------------------- internal: receiving

  private onData(chunk: Buffer): void {
    this.lastReceived = Date.now();
    this.emitMetric({ name: 'bytes.in', type: 'counter', value: chunk.length });
    const { frames, error } = this.framer.push(chunk);
    for (const frame of frames) {
      if (this.inputHeld || this.pendingFrames.length > 0) this.pendingFrames.push(frame);
      else this.handleFrame(frame);
    }
    if (error) {
      // Stream out of sync: the next PDU boundary cannot be found (BUG-08).
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
      // A listener error must never break the session.
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
      // Unreadable response: reject the matching request, without a nack.
      const req = this.inflight.get(header.sequence_number);
      req?.reject(e);
      this.dispatch();
      return;
    }
    // Unreadable request: generic_nack, and the session goes on (BUG-08).
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
      // Command not allowed in this state or bind mode (SEC-06, SEC-07).
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
            // Half-open connection: the session is declared dead (BUG-07).
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

  // ---------------------------------------------------------------- closing

  private endSocket(): void {
    if (this.socket.destroyed) return;
    this.socket.end();
    // The peer may never close: force it after unbindTimeout.
    const t = setTimeout(() => this.socket.destroy(), this.timeouts.unbindTimeout);
    t.unref?.();
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.rateTimer) clearTimeout(this.rateTimer);
    const cause = this.closeError;
    // BUG-02: every in-flight request is rejected, flagged with whether it was written.
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

  // ---------------------------------------------------------------- observability

  /** Emits `error` if someone listens, otherwise logs it: never crashes the process. */
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
      // a failing logger must not break the session
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
