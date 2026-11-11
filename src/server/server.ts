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
import { ServerSession } from './server-session.js';

export interface AuthContext {
  system_id: string;
  password: string;
  system_type: string;
  interface_version: number;
  remoteAddress: string;
  mode: BindMode;
}

/** `true` or a context object: accepted. `false`: refused (ESME_RBINDFAIL, whatever the reason). */
export type Authenticate<Ctx> = (ctx: AuthContext) => Promise<boolean | Ctx> | boolean | Ctx;

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
  bindFailed: [info: { remoteAddress: string; system_id: string; banned: boolean }];
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
  private readonly handlers: Handlers<Ctx>;
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

  /** Starts listening. */
  listen(port = 2775, host?: string): Promise<net.AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
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
    await closed;
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

    // Counted from now until the socket closes, whatever stage it reaches (handshake, PROXY header…).
    this.connections++;
    this.countIp(ip, 1);
    let countedIp: string = ip;
    socket.once('close', () => {
      this.connections--;
      this.countIp(countedIp, -1);
    });

    let stream: Duplex = socket;
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
      const tlsSocket = new tls.TLSSocket(stream === socket ? socket : (stream as unknown as net.Socket), {
        isServer: true,
        secureContext: this.secureContext,
        requestCert: Boolean(this.options.tls?.requestCert),
        rejectUnauthorized: this.options.tls?.rejectUnauthorized ?? true,
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
    }

    this.startSession(stream, socket, ip);
  }

  private startSession(stream: Duplex, raw: net.Socket, ip: string): void {
    const o = this.options;
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
      logContext: { remoteAddress: ip },
    });
    const ss = new ServerSession<Ctx>(session, ip);
    this.sessions.add(ss);

    // SEC-05: an unbound session is closed after bindTimeout.
    const bindTimer = setTimeout(() => {
      if (ss.mode === undefined) {
        this.logger.warn('bind timeout, closing session', { remoteAddress: ip });
        session.destroy();
      }
    }, o.bindTimeout ?? 30_000);
    bindTimer.unref?.();

    // Inbound window: bounds the handlers running at the same time for this session.
    const inboundWindow = Math.max(1, o.inboundWindow ?? 10);
    const throttle = o.inboundWindowPolicy === 'throttle';
    let active = 0;
    let windowPaused = false;
    session.on('pdu', (pdu) => {
      if (bindModeOf(pdu.command) || !responseNameOf(pdu.command)) {
        void this.onPdu(ss, pdu);
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
      if (handler) await Promise.resolve(handler(pdu as never, ss)).catch(() => {});
      return;
    }
    const req = pdu as { command: RequestCommandName; sequence_number: number };
    if (!handler) {
      ss.session.respond(req, { command_status: COMMAND_STATUS.ESME_RINVCMDID });
      return;
    }
    const timeoutMs = this.options.handlerTimeout ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => handler(pdu as never, ss)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new SmppError('SMPP_HANDLER_TIMEOUT', `${command} handler timed out`)),
            timeoutMs,
          );
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
    let accepted: boolean | Ctx = false;
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
    try {
      if (reserved) {
        const timeoutMs = this.options.handlerTimeout ?? 10_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        accepted = await Promise.race([
          Promise.resolve().then(() =>
            this.options.authenticate({
              system_id: pdu.system_id,
              password: pdu.password,
              system_type: pdu.system_type,
              interface_version: pdu.interface_version,
              remoteAddress: ip,
              mode,
            }),
          ),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
      } else {
        this.logger.warn('maxSessionsPerSystemId reached', { systemId: pdu.system_id, remoteAddress: ip });
      }
    } catch (err) {
      this.logger.warn('authenticate() threw', { error: toError(err).message });
      accepted = false;
    }

    if (session.isClosed) {
      releaseSlot();
      return;
    }
    if (accepted === false || accepted === null || accepted === undefined) {
      releaseSlot();
      // Same response whether the system_id exists or not (SEC-06).
      const banned = this.failures.recordFailure(ip);
      this.logger.warn('bind rejected', { systemId: pdu.system_id, remoteAddress: ip, banned });
      this.emitSafe('bindFailed', { remoteAddress: ip, system_id: pdu.system_id, banned });
      session.respond(pdu, { command_status: COMMAND_STATUS.ESME_RBINDFAIL });
      await session.close();
      return;
    }

    this.failures.recordSuccess(ip);
    ss.mode = mode;
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

  // ---------------------------------------------------------------- helpers

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
