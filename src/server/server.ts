import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { type CodecOptions, type Pdu, PduCodec, type PduOf, type PduParams } from '../codec/pdu.js';
import { SmppError, SmppStateError, toError } from '../errors.js';
import { type Logger, type RedactOptions, silentLogger } from '../logger.js';
import type { Metric } from '../metrics.js';
import type { RequestCommandName, ResponseCommandName } from '../protocol/commands.js';
import { responseNameOf } from '../protocol/commands.js';
import { COMMAND_STATUS } from '../protocol/status.js';
import { type RateLimitOptions, TokenBucket } from '../session/rate-limiter.js';
import { type RequestOptions, type ResponseOf, Session } from '../session/session.js';
import { type BindMode, bindModeOf } from '../session/state-machine.js';
import {
  CidrList,
  type ProxyProtocolOptions,
  normalizeIp,
  readProxyHeader,
  rejectSpoofedProxyHeader,
} from '../transport/proxy-protocol.js';
import { type BindFailurePolicy, BindFailureTracker } from './auth.js';
import { ConnectionRateLimiter, type ConnectionRatePolicy } from './limits.js';
import { ServerSession, type TlsPeerInfo } from './server-session.js';

export interface AuthContext {
  system_id: string;
  password: string;
  system_type: string;
  interface_version: number;
  remoteAddress: string;
  mode: BindMode;
  /**
   * TLS details of the connection, `undefined` on plain TCP: lets `authenticate()` check a client
   * certificate (mTLS) on top of, or instead of, the password. See `TlsPeerInfo` for the two setups
   * (`rejectUnauthorized` true or false) and what `authorized` means in each.
   */
  tls?: TlsPeerInfo;
  /**
   * Aborted when `handlerTimeout` expires or the connection closes: the bind has then already been
   * answered, so the result is ignored.
   */
  signal: AbortSignal;
}

/**
 * Accepted only on `true` or a non-null object (which becomes `session.context`).
 * Any other value (`false`, `null`, `undefined`, `0`, `''`, `NaN`…) is a refusal: ESME_RBINDFAIL,
 * whether the account exists or not. An exception or a timeout answers ESME_RSYSERR.
 */
export type Authenticate<Ctx> = (
  ctx: AuthContext,
) => Promise<boolean | (Ctx & object) | null | undefined> | boolean | (Ctx & object) | null | undefined;

/** Why a bind was refused (`bindFailed` event). Only `credentials` counts toward the IP ban. */
export type BindFailureReason = 'credentials' | 'limit' | 'timeout' | 'error';

/** Third argument of a handler. */
export interface HandlerContext {
  /**
   * Aborted when `handlerTimeout` expires (the peer already received ESME_RSYSERR) or the session
   * closes. `signal.reason` is a `SmppError` (`SMPP_HANDLER_TIMEOUT` or `SMPP_SESSION_CLOSED`).
   * Check it before committing work, or pass it on, so a peer retrying on ESME_RSYSERR does not
   * create duplicates.
   */
  signal: AbortSignal;
}

/** Incoming commands a handler can process. */
export type HandledCommand = Exclude<
  RequestCommandName,
  | 'bind_transmitter'
  | 'bind_receiver'
  | 'bind_transceiver'
  | 'unbind'
  | 'enquire_link'
  | 'outbind'
  | 'deliver_sm'
  | 'alert_notification'
>;

type RespParams<C extends HandledCommand> = `${C}_resp` extends ResponseCommandName
  ? PduParams<`${C}_resp`>
  : never;

/**
 * Value returned by a handler:
 * - nothing → response with status 0;
 * - a number → command_status;
 * - an object → response fields (and optionally command_status).
 * An exception carrying `status` (e.g. `SmppStatusError`) gives that status; anything else → ESME_RSYSERR.
 */
export type HandlerResult<C extends HandledCommand> =
  // biome-ignore lint/suspicious/noConfusingVoidType: a handler may return nothing
  void | number | (RespParams<C> & { command_status?: number });

export type Handler<C extends HandledCommand, Ctx> = (
  pdu: PduOf<C>,
  session: ServerSession<Ctx>,
  context: HandlerContext,
) => Promise<HandlerResult<C>> | HandlerResult<C>;

export type Handlers<Ctx> = { [C in HandledCommand]?: Handler<C, Ctx> };

export interface SmppServerOptions<Ctx = unknown> {
  /** Authentication hook (required: without it, no bind can succeed). */
  authenticate: Authenticate<Ctx>;
  handlers?: Handlers<Ctx>;
  /** TLS options: providing them enables TLS. */
  tls?: tls.TlsOptions;
  /** system_id returned in bind_resp. Default: `smpp-ts`. */
  systemId?: string;

  /** An open but unbound session is closed after this delay. Default: 30 s. */
  bindTimeout?: number;
  /** Maximum duration of the TLS handshake. Default: 10 s. */
  handshakeTimeout?: number;
  /** A bound session without traffic is closed after this delay. Default: 5 min. 0 = disabled. */
  idleTimeout?: number;
  /** Maximum handler time before an automatic ESME_RSYSERR response. Default: 10 s. */
  handlerTimeout?: number;
  /**
   * Maximum number of connections, counted from the moment they are accepted
   * (PROXY header and TLS handshake included). Default: 1000.
   */
  maxSessions?: number;
  /** Maximum number of connections per IP, counted like `maxSessions`. Default: 50. */
  maxSessionsPerIp?: number;
  /** Maximum number of bound sessions per system_id, binds in progress included. Default: 10. */
  maxSessionsPerSystemId?: number;
  /**
   * Failed binds tolerated per IP before a temporary ban. Brute force on one system_id
   * from many addresses must be handled in `authenticate()`.
   */
  bindFailures?: BindFailurePolicy;
  /**
   * Maximum number of incoming requests handled at the same time per session
   * (handlers that have not answered yet). Default: 10.
   */
  inboundWindow?: number;
  /**
   * What happens when the inbound window is full:
   * - `pause` (default): reading stops until a handler answers (TCP backpressure);
   * - `throttle`: extra requests are answered at once with ESME_RTHROTTLED.
   */
  inboundWindowPolicy?: 'pause' | 'throttle';
  /** Bytes allowed in a session's write buffer before it is closed. Default: 1 MiB. */
  maxWriteBuffer?: number;
  /**
   * Bytes allowed in the write buffers of every session together: beyond it the heaviest sessions
   * are closed until the total fits. Default: 64 MiB. 0 = no limit.
   *
   * `maxWriteBuffer` bounds one session; without this budget, `maxSessions` sessions each just under
   * their own limit still add up (1 000 × 1 MiB).
   */
  maxTotalWriteBuffer?: number;
  /**
   * Requests accepted per second and per session, on top of `inboundWindow` (which bounds
   * concurrency, not rate). Beyond it a request is answered at once with `ESME_RTHROTTLED`.
   * Off by default — an operator selling a throughput tier sets it here.
   */
  inboundRate?: RateLimitOptions;
  /**
   * Adds the SMPP 5.0 `congestion_state` TLV (0-100) to the responses of peers that announced
   * `interface_version` 0x50, derived from how full the inbound window and the session slots are.
   * A client that honours it slows down before anything has to be rejected. Default: true.
   */
  congestionReporting?: boolean;
  /** Logs every PDU at the `debug` level. Default: what the logger's level says. */
  logPdus?: boolean;
  /** Minimum delay between two emissions of the same gauge metric. Default: 50 ms. */
  gaugeInterval?: number;
  /**
   * Rate of accepted connections, per address and in total (SEC-05).
   * Default: 20 per second per address, burst of 40; no total limit. `false` disables it.
   */
  connectionRate?: ConnectionRatePolicy | false;

  /** Proxy Protocol v1/v2. Disabled by default. */
  proxyProtocol?: ProxyProtocolOptions;

  window?: number;
  maxQueueSize?: number;
  requestTimeout?: number;
  /** Server-initiated enquire_link. Default: 0 (disabled, the client takes care of it). */
  enquireLinkInterval?: number;
  enquireLinkTimeout?: number;
  unbindTimeout?: number;

  logger?: Logger;
  redact?: RedactOptions;
  codec?: CodecOptions;
}

export interface ServerEvents<Ctx> {
  listening: [address: net.AddressInfo];
  session: [session: ServerSession<Ctx>];
  bind: [session: ServerSession<Ctx>];
  bindFailed: [
    info: { remoteAddress: string; system_id: string; banned: boolean; reason: BindFailureReason },
  ];
  sessionClose: [session: ServerSession<Ctx>];
  rejected: [info: { remoteAddress: string; reason: string }];
  error: [error: SmppError];
  metric: [metric: Metric, session: ServerSession<Ctx>];
}

/** SMPP server (SMSC / simulator). */
export class SmppServer<Ctx = unknown> extends EventEmitter<ServerEvents<Ctx>> {
  readonly sessions: Set<ServerSession<Ctx>> = new Set();
  private readonly options: SmppServerOptions<Ctx>;
  private readonly logger: Logger;
  private readonly codec: PduCodec;
  private readonly server: net.Server;
  private readonly failures: BindFailureTracker;
  private readonly trusted: CidrList | undefined;
  private readonly secureContext: tls.SecureContext | undefined;
  /** Accepted connections, whatever their stage (PROXY header, TLS handshake, session). */
  private connections = 0;
  private readonly perIp = new Map<string, number>();
  /** Binds being authenticated, per system_id: they hold a slot of maxSessionsPerSystemId. */
  private readonly pendingBinds = new Map<string, number>();
  /** In-flight handler and authenticate() controllers, aborted by one shared `close` listener (#31). */
  private readonly inflight = new WeakMap<ServerSession<Ctx>, Set<AbortController>>();
  private readonly handlers: Handlers<Ctx>;
  private readonly rate: ConnectionRateLimiter | undefined;
  private writeBudgetTimer: ReturnType<typeof setInterval> | undefined;
  private rr = 0;

  constructor(options: SmppServerOptions<Ctx>) {
    super();
    if (typeof options.authenticate !== 'function') {
      throw new SmppError('SMPP_CONFIG', 'SmppServer requires an authenticate() hook');
    }
    this.options = options;
    this.handlers = options.handlers ?? {};
    this.logger = options.logger ?? silentLogger;
    this.codec = new PduCodec(options.codec);
    this.failures = new BindFailureTracker(options.bindFailures);
    if (options.connectionRate !== false) {
      this.rate = new ConnectionRateLimiter(options.connectionRate ?? {});
    }
    if (options.proxyProtocol) {
      if (!options.proxyProtocol.trustedProxies?.length) {
        throw new SmppError('SMPP_CONFIG', 'proxyProtocol.trustedProxies must list at least one CIDR');
      }
      this.trusted = new CidrList(options.proxyProtocol.trustedProxies);
    }
    if (options.tls) {
      this.secureContext = tls.createSecureContext({ minVersion: 'TLSv1.2', ...options.tls });
    }
    this.server = net.createServer({ pauseOnConnect: true }, (socket) => {
      this.onConnection(socket).catch((err: unknown) => {
        this.logger.warn('connection rejected', { error: toError(err).message });
        socket.destroy();
      });
    });
    this.server.on('error', (err) =>
      this.emitError(new SmppError('SMPP_SERVER', err.message, { cause: err })),
    );
  }

  /** Starts listening. `backlog` is the kernel accept queue (Node's default: 511). */
  listen(port = 2775, host?: string, backlog?: number): Promise<net.AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      // Options form: a positional `backlog` of `undefined` is not portable across runtimes.
      const options: net.ListenOptions = { port };
      if (host !== undefined) options.host = host;
      if (backlog !== undefined) options.backlog = backlog;
      this.server.listen(options, () => {
        this.server.off('error', onError);
        const addr = this.server.address() as net.AddressInfo;
        this.logger.info('SMPP server listening', {
          port: addr.port,
          address: addr.address,
          tls: Boolean(this.secureContext),
        });
        this.emit('listening', addr);
        resolve(addr);
      });
    });
  }

  get address(): net.AddressInfo | undefined {
    return (this.server.address() as net.AddressInfo | null) ?? undefined;
  }

  /** Stops listening and closes every session cleanly (unbind). */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled([...this.sessions].map((s) => s.close()));
    this.stopWriteBudgetWatch();
    await closed;
  }

  /** Bytes waiting in the write buffers of every session (what `maxTotalWriteBuffer` bounds). */
  get bufferedBytes(): number {
    let total = 0;
    for (const ss of this.sessions) total += ss.session.bufferedBytes;
    return total;
  }

  /** Bound sessions for a system_id. */
  sessionsFor(systemId: string): ServerSession<Ctx>[] {
    return [...this.sessions].filter((s) => s.systemId === systemId && s.mode !== undefined);
  }

  /** Sends a deliver_sm to a receiver/transceiver session of the system_id (round robin). */
  deliver(
    systemId: string,
    params: PduParams<'deliver_sm'>,
    options?: RequestOptions,
  ): Promise<ResponseOf<'deliver_sm'>> {
    const candidates = this.sessionsFor(systemId).filter((s) => s.canDeliver);
    if (candidates.length === 0) {
      return Promise.reject(
        new SmppStateError(
          'deliver_sm',
          'NO_RECEIVER',
          COMMAND_STATUS.ESME_RINVBNDSTS,
          `No receiver session bound for ${systemId}`,
        ),
      );
    }
    const target = candidates[this.rr++ % candidates.length]!;
    return target.deliver(params, options);
  }

  // ---------------------------------------------------------------- connections

  private reject(socket: net.Socket, ip: string, reason: string): void {
    this.logger.warn('connection rejected', { remoteAddress: ip, reason });
    this.emit('rejected', { remoteAddress: ip, reason });
    socket.destroy();
  }

  /** Checks the limits before counting a new connection (`checkTotal`) or moving it to another IP. */
  private admissible(ip: string, checkTotal = true): string | undefined {
    if (this.failures.isBanned(ip)) return 'banned after repeated bind failures';
    if (checkTotal && this.connections >= (this.options.maxSessions ?? 1000)) return 'maxSessions reached';
    if ((this.perIp.get(ip) ?? 0) >= (this.options.maxSessionsPerIp ?? 50)) return 'maxSessionsPerIp reached';
    return undefined;
  }

  private countIp(ip: string, delta: 1 | -1): void {
    const n = (this.perIp.get(ip) ?? 0) + delta;
    if (n <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, n);
  }

  private async onConnection(socket: net.Socket): Promise<void> {
    socket.on('error', () => {}); // errors are handled by the session or by destroy()
    let ip = normalizeIp(socket.remoteAddress ?? 'unknown');
    const early = this.admissible(ip);
    if (early) return this.reject(socket, ip, early);
    // Before any byte is read, and before TLS: a connect/disconnect loop must not burn CPU.
    const verdict = this.rate?.check(ip) ?? 'ok';
    if (verdict !== 'ok') {
      return this.reject(
        socket,
        ip,
        verdict === 'ip-rate' ? 'connection rate per address exceeded' : 'total connection rate exceeded',
      );
    }

    // Counted from now until the socket closes, whatever stage it reaches (handshake, PROXY header…).
    this.connections++;
    this.countIp(ip, 1);
    let countedIp: string = ip;
    socket.once('close', () => {
      this.connections--;
      this.countIp(countedIp, -1);
    });

    let stream: Duplex = socket;
    let tlsInfo: TlsPeerInfo | undefined;
    if (this.trusted) {
      const timeout = this.options.proxyProtocol?.headerTimeout ?? 5_000;
      if (this.trusted.has(ip)) {
        const header = await readProxyHeader(socket, timeout);
        if (header.command === 'PROXY' && header.sourceAddress) {
          ip = normalizeIp(header.sourceAddress);
          if (ip !== countedIp) {
            const late = this.admissible(ip, false);
            if (late) return this.reject(socket, ip, late);
            this.countIp(countedIp, -1);
            this.countIp(ip, 1);
            countedIp = ip;
          }
        }
        // The bytes after the header were pushed back into the stream: TLS must read through a JS stream.
        if (this.secureContext) stream = Duplex.from({ readable: socket, writable: socket });
      } else if (!this.secureContext) {
        await rejectSpoofedProxyHeader(socket, timeout);
      }
    }

    if (this.secureContext) {
      const requestCert = Boolean(this.options.tls?.requestCert);
      const rejectUnauthorized = this.options.tls?.rejectUnauthorized ?? true;
      const tlsSocket = new tls.TLSSocket(stream === socket ? socket : (stream as unknown as net.Socket), {
        isServer: true,
        secureContext: this.secureContext,
        requestCert,
        rejectUnauthorized,
      });
      tlsSocket.on('error', () => tlsSocket.destroy());
      socket.resume();
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new SmppError('SMPP_TLS', 'TLS handshake timeout')),
          this.options.handshakeTimeout ?? 10_000,
        );
        tlsSocket.once('secure', () => {
          clearTimeout(t);
          resolve();
        });
        tlsSocket.once('close', () => {
          clearTimeout(t);
          reject(new SmppError('SMPP_TLS', 'TLS handshake failed'));
        });
      });
      stream = tlsSocket;
      // Reaching this point with both flags on means OpenSSL verified the client chain itself.
      tlsInfo = peerInfo(tlsSocket, requestCert && rejectUnauthorized);
    }

    this.startSession(stream, socket, ip, tlsInfo);
  }

  private startSession(stream: Duplex, raw: net.Socket, ip: string, tlsInfo?: TlsPeerInfo): void {
    const o = this.options;
    // Inbound window: bounds the handlers running at the same time for this session.
    const inboundWindow = Math.max(1, o.inboundWindow ?? 10);
    const inboundBucket = o.inboundRate ? new TokenBucket(o.inboundRate) : undefined;
    let active = 0;
    const session = new Session(stream as Duplex & { remoteAddress?: string }, {
      role: 'smsc',
      codec: this.codec,
      logger: this.logger,
      ...(o.redact ? { redact: o.redact } : {}),
      window: o.window ?? 10,
      maxQueueSize: o.maxQueueSize ?? 10_000,
      requestTimeout: o.requestTimeout ?? 10_000,
      enquireLinkInterval: o.enquireLinkInterval ?? 0,
      enquireLinkTimeout: o.enquireLinkTimeout ?? 10_000,
      unbindTimeout: o.unbindTimeout ?? 5_000,
      idleTimeout: o.idleTimeout ?? 5 * 60_000,
      ...(o.maxWriteBuffer !== undefined ? { maxWriteBuffer: o.maxWriteBuffer } : {}),
      ...(o.logPdus !== undefined ? { logPdus: o.logPdus } : {}),
      ...(o.gaugeInterval !== undefined ? { gaugeInterval: o.gaugeInterval } : {}),
      logContext: { remoteAddress: ip },
    });
    const ss = new ServerSession<Ctx>(session, ip, tlsInfo);
    // Tells a v5.0 peer how loaded we are, in every response it gets.
    session.responseExtras = () => this.congestionExtras(ss, active, inboundWindow);
    this.sessions.add(ss);
    this.startWriteBudgetWatch();
    // One close listener aborts every in-flight handler, whatever inboundWindow is (#31).
    const inflight = new Set<AbortController>();
    this.inflight.set(ss, inflight);
    session.once('close', () => {
      const reason = new SmppError('SMPP_SESSION_CLOSED', 'session closed before the handler answered');
      for (const ac of inflight) ac.abort(reason);
      inflight.clear();
    });

    // SEC-05: an unbound session is closed after bindTimeout.
    const bindTimer = setTimeout(() => {
      if (ss.mode === undefined) {
        this.logger.warn('bind timeout, closing session', { remoteAddress: ip });
        session.destroy();
      }
    }, o.bindTimeout ?? 30_000);
    bindTimer.unref?.();

    const throttle = o.inboundWindowPolicy === 'throttle';
    let windowPaused = false;
    session.on('pdu', (pdu) => {
      if (bindModeOf(pdu.command) || !responseNameOf(pdu.command)) {
        void this.onPdu(ss, pdu);
        return;
      }
      // Rate limit, on top of the concurrency limit below.
      if (inboundBucket && inboundBucket.take() > 0) {
        session.respond(pdu as { command: RequestCommandName; sequence_number: number }, {
          command_status: COMMAND_STATUS.ESME_RTHROTTLED,
        });
        return;
      }
      if (active >= inboundWindow) {
        // Only reachable with `throttle`: with `pause`, reading stopped when the window filled up.
        session.respond(pdu as { command: RequestCommandName; sequence_number: number }, {
          command_status: COMMAND_STATUS.ESME_RTHROTTLED,
        });
        return;
      }
      active++;
      if (!throttle && active >= inboundWindow && !session.isPaused) {
        windowPaused = true;
        session.pause();
      }
      void this.onPdu(ss, pdu).finally(() => {
        active--;
        if (windowPaused && active < inboundWindow) {
          windowPaused = false;
          session.resume();
        }
      });
    });
    session.on('metric', (m) => {
      if (this.listenerCount('metric') > 0) this.emit('metric', m, ss);
    });
    session.on('error', (err) => this.emitError(err));
    session.on('close', () => {
      clearTimeout(bindTimer);
      this.sessions.delete(ss);
      if (this.sessions.size === 0) this.stopWriteBudgetWatch();
      this.emitSafe('sessionClose', ss);
    });
    this.emitSafe('session', ss);
    raw.resume();
    stream.resume();
  }

  // ---------------------------------------------------------------- incoming PDUs

  private async onPdu(ss: ServerSession<Ctx>, pdu: Pdu): Promise<void> {
    const mode = bindModeOf(pdu.command);
    if (mode) return this.onBind(ss, pdu as PduOf<'bind_transceiver'>, mode);

    const command = pdu.command as HandledCommand;
    const handler = this.handlers[command] as Handler<HandledCommand, Ctx> | undefined;
    if (!responseNameOf(pdu.command)) {
      // No response expected: notify the handler, if any.
      if (handler) {
        const ac = this.abortOnClose(ss);
        await Promise.resolve()
          .then(() => handler(pdu as never, ss, { signal: ac.signal }))
          .catch(() => {})
          .finally(ac.dispose);
      }
      return;
    }
    const req = pdu as { command: RequestCommandName; sequence_number: number };
    if (!handler) {
      ss.session.respond(req, { command_status: COMMAND_STATUS.ESME_RINVCMDID });
      return;
    }
    const timeoutMs = this.options.handlerTimeout ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = this.abortOnClose(ss);
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => handler(pdu as never, ss, { signal: ac.signal })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new SmppError('SMPP_HANDLER_TIMEOUT', `${command} handler timed out`);
            ac.abort(err);
            reject(err);
          }, timeoutMs);
        }),
      ]);
      try {
        if (typeof result === 'number') ss.session.respond(req, { command_status: result });
        else ss.session.respond(req, (result ?? {}) as never);
      } catch (err) {
        // The handler returned fields that cannot be encoded: the peer still gets an answer.
        this.logger.warn(`${command} handler returned an invalid response`, { error: toError(err).message });
        ss.session.respond(req, { command_status: COMMAND_STATUS.ESME_RSYSERR });
      }
    } catch (err) {
      const status = statusOf(err);
      this.logger.warn(`${command} handler failed`, { error: toError(err).message, status });
      ss.session.respond(req, { command_status: status });
    } finally {
      if (timer) clearTimeout(timer);
      ac.dispose();
    }
  }

  private async onBind(
    ss: ServerSession<Ctx>,
    pdu: PduOf<'bind_transceiver'>,
    mode: BindMode,
  ): Promise<void> {
    const session = ss.session;
    const ip = ss.remoteAddress;
    session.pause(); // keeps ordering during asynchronous authentication (REL-09)
    let accepted: unknown = false;
    let failure: BindFailureReason | undefined;
    const systemId = pdu.system_id;
    // The slot is reserved before authenticate() resolves: concurrent binds cannot exceed the limit.
    const perSystem = this.options.maxSessionsPerSystemId ?? 10;
    const reserved = this.sessionsFor(systemId).length + (this.pendingBinds.get(systemId) ?? 0) < perSystem;
    if (reserved) this.pendingBinds.set(systemId, (this.pendingBinds.get(systemId) ?? 0) + 1);
    const releaseSlot = () => {
      if (!reserved) return;
      const n = (this.pendingBinds.get(systemId) ?? 1) - 1;
      if (n <= 0) this.pendingBinds.delete(systemId);
      else this.pendingBinds.set(systemId, n);
    };
    if (!reserved) {
      failure = 'limit';
      this.logger.warn('maxSessionsPerSystemId reached', { systemId: pdu.system_id, remoteAddress: ip });
    } else {
      const timeoutMs = this.options.handlerTimeout ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ac = this.abortOnClose(ss);
      const timedOut = Symbol('timeout');
      try {
        accepted = await Promise.race([
          Promise.resolve().then(() =>
            this.options.authenticate({
              system_id: pdu.system_id,
              password: pdu.password,
              system_type: pdu.system_type,
              interface_version: pdu.interface_version,
              remoteAddress: ip,
              mode,
              ...(ss.tls ? { tls: ss.tls } : {}),
              signal: ac.signal,
            }),
          ),
          new Promise<typeof timedOut>((resolve) => {
            timer = setTimeout(() => {
              ac.abort(new SmppError('SMPP_HANDLER_TIMEOUT', 'authenticate() timed out'));
              resolve(timedOut);
            }, timeoutMs);
          }),
        ]);
        if (accepted === timedOut) {
          failure = 'timeout';
          this.logger.warn('authenticate() timed out', { systemId: pdu.system_id, remoteAddress: ip });
        }
      } catch (err) {
        failure = 'error';
        this.logger.warn('authenticate() threw', { error: toError(err).message });
      } finally {
        clearTimeout(timer);
        ac.dispose();
      }
      // Only `true` or an object binds: 0, '', NaN, 'yes'… are refusals (#23).
      if (!failure && accepted !== true && (typeof accepted !== 'object' || accepted === null)) {
        failure = 'credentials';
      }
    }

    if (session.isClosed) {
      releaseSlot();
      return;
    }
    if (failure) {
      releaseSlot();
      // Only a refusal by authenticate() counts toward the IP ban: a session limit, a slow or failing
      // backend says nothing about the credentials, and banning would lock out every account behind
      // that IP (#24).
      const banned = failure === 'credentials' ? this.failures.recordFailure(ip) : false;
      this.logger.warn('bind rejected', {
        systemId: pdu.system_id,
        remoteAddress: ip,
        reason: failure,
        banned,
      });
      this.emitSafe('bindFailed', { remoteAddress: ip, system_id: pdu.system_id, banned, reason: failure });
      // Same response whether the system_id exists or not (SEC-06). A backend failure is transient:
      // ESME_RSYSERR, so the ESME retries instead of treating it as a wrong password.
      const status =
        failure === 'timeout' || failure === 'error'
          ? COMMAND_STATUS.ESME_RSYSERR
          : COMMAND_STATUS.ESME_RBINDFAIL;
      session.respond(pdu, { command_status: status });
      await session.close();
      return;
    }

    this.failures.recordSuccess(ip);
    ss.mode = mode;
    ss.interfaceVersion = pdu.interface_version;
    ss.context = accepted === true ? undefined : (accepted as Ctx);
    session.context = ss.context;
    const respParams: PduParams<'bind_transceiver_resp'> = { system_id: this.options.systemId ?? 'smpp-ts' };
    if (pdu.interface_version >= 0x34) respParams.sc_interface_version = 0x50;
    session.respond(pdu, respParams);
    session.markBound(mode, pdu.system_id);
    releaseSlot(); // the bound session now counts in sessionsFor()
    session.resume();
    this.logger.info('session bound', { systemId: pdu.system_id, remoteAddress: ip, mode });
    this.emitSafe('bind', ss);
  }

  // ---------------------------------------------------------------- congestion

  /**
   * SMPP 5.0 `congestion_state` (0-100) for this session's responses: the fuller the inbound window
   * and the session slots are, the higher. Only sent to a peer that announced v5.0 — a v3.4 peer
   * does not expect the TLV.
   */
  private congestionExtras(
    ss: ServerSession<Ctx>,
    active: number,
    inboundWindow: number,
  ): Record<string, unknown> | undefined {
    if (this.options.congestionReporting === false) return undefined;
    if ((ss.interfaceVersion ?? 0) < 0x50) return undefined;
    const load = Math.max(active / inboundWindow, this.connections / (this.options.maxSessions ?? 1000));
    return { congestion_state: Math.max(0, Math.min(100, Math.round(load * 100))) };
  }

  // ---------------------------------------------------------------- write budget

  private startWriteBudgetWatch(): void {
    if (this.writeBudgetTimer || (this.options.maxTotalWriteBuffer ?? DEFAULT_TOTAL_WRITE_BUFFER) <= 0)
      return;
    this.writeBudgetTimer = setInterval(() => this.checkWriteBudget(), 500);
    this.writeBudgetTimer.unref?.();
  }

  private stopWriteBudgetWatch(): void {
    if (this.writeBudgetTimer) clearInterval(this.writeBudgetTimer);
    this.writeBudgetTimer = undefined;
  }

  /** Closes the heaviest sessions while the write buffers exceed the budget together. */
  private checkWriteBudget(): void {
    const budget = this.options.maxTotalWriteBuffer ?? DEFAULT_TOTAL_WRITE_BUFFER;
    if (budget <= 0) return;
    const sessions = [...this.sessions];
    let total = 0;
    for (const ss of sessions) total += ss.session.bufferedBytes;
    if (total <= budget) return;
    sessions.sort((a, b) => b.session.bufferedBytes - a.session.bufferedBytes);
    for (const ss of sessions) {
      if (total <= budget) return;
      const bytes = ss.session.bufferedBytes;
      this.logger.error('total write buffer budget exceeded, closing the heaviest session', {
        sessionId: ss.id,
        remoteAddress: ss.remoteAddress,
        writableLength: bytes,
        total,
        maxTotalWriteBuffer: budget,
      });
      ss.session.destroy(new SmppError('SMPP_WRITE_BUDGET', `Server write buffers over ${budget} bytes`));
      total -= bytes;
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * AbortController aborted when the session closes; `dispose()` forgets it.
   * Shares the session's single close listener instead of adding one per call (#31).
   */
  private abortOnClose(ss: ServerSession<Ctx>): {
    signal: AbortSignal;
    abort: (reason: unknown) => void;
    dispose: () => void;
  } {
    const ac = new AbortController();
    const inflight = this.inflight.get(ss);
    if (ss.session.isClosed || !inflight) {
      ac.abort(new SmppError('SMPP_SESSION_CLOSED', 'session closed before the handler answered'));
    } else {
      inflight.add(ac);
    }
    return {
      signal: ac.signal,
      abort: (reason) => ac.abort(reason),
      dispose: () => inflight?.delete(ac),
    };
  }

  private emitSafe<K extends keyof ServerEvents<Ctx>>(event: K, ...args: ServerEvents<Ctx>[K]): void {
    try {
      (this.emit as (e: K, ...a: ServerEvents<Ctx>[K]) => boolean)(event, ...args);
    } catch (err) {
      this.logger.error(`listener for "${String(event)}" threw`, { error: toError(err).message });
    }
  }

  private emitError(err: SmppError): void {
    if (this.listenerCount('error') > 0) this.emitSafe('error', err);
    else this.logger.error(err.message, { code: err.code });
  }
}

/** Default aggregate write-buffer budget: 64 MiB. */
const DEFAULT_TOTAL_WRITE_BUFFER = 64 * 1024 * 1024;

/**
 * TLS details handed to `authenticate()` (SEC-06: client-certificate authentication).
 *
 * `verified` says whether the handshake enforced client-certificate verification. A server-side
 * `tls.TLSSocket` built on an accepted socket leaves `authorized` at false even when OpenSSL did
 * verify the chain, so the flag is derived from the handshake having succeeded under
 * `requestCert` + `rejectUnauthorized`, with a peer certificate present.
 */
function peerInfo(socket: tls.TLSSocket, verified: boolean): TlsPeerInfo {
  const cert = socket.getPeerCertificate();
  const hasCert = Boolean(cert) && Object.keys(cert).length > 0;
  const info: TlsPeerInfo = { authorized: socket.authorized || (verified && hasCert) };
  const error = socket.authorizationError as Error | string | undefined;
  if (error) info.authorizationError = typeof error === 'string' ? error : error.message;
  const protocol = socket.getProtocol();
  if (protocol) info.protocol = protocol;
  const cipher = socket.getCipher()?.name;
  if (cipher) info.cipher = cipher;
  if (hasCert) {
    if (cert.subject) info.subject = cert.subject as unknown as Record<string, unknown>;
    if (cert.issuer) info.issuer = cert.issuer as unknown as Record<string, unknown>;
    if (cert.fingerprint256) info.fingerprint256 = cert.fingerprint256;
    if (cert.valid_to) info.validTo = cert.valid_to;
  }
  return info;
}

function statusOf(err: unknown): number {
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  ) {
    const s = (err as { status: number }).status;
    if (s > 0) return s;
  }
  return COMMAND_STATUS.ESME_RSYSERR;
}
