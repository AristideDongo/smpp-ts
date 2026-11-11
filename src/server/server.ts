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

/** `true`/objet de contexte : accepté. `false` : refusé (ESME_RBINDFAIL, sans distinction de cause). */
export type Authenticate<Ctx> = (ctx: AuthContext) => Promise<boolean | Ctx> | boolean | Ctx;

/** Commandes entrantes qu'un handler peut traiter. */
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
 * Valeur renvoyée par un handler :
 * - rien → réponse avec statut 0 ;
 * - un nombre → command_status ;
 * - un objet → champs de la réponse (et éventuellement command_status).
 * Une exception portant `status` (ex. `SmppStatusError`) donne ce statut ; toute autre → ESME_RSYSERR.
 */
export type HandlerResult<C extends HandledCommand> =
  // biome-ignore lint/suspicious/noConfusingVoidType: un handler peut ne rien renvoyer
  void | number | (RespParams<C> & { command_status?: number });

export type Handler<C extends HandledCommand, Ctx> = (
  pdu: PduOf<C>,
  session: ServerSession<Ctx>,
) => Promise<HandlerResult<C>> | HandlerResult<C>;

export type Handlers<Ctx> = { [C in HandledCommand]?: Handler<C, Ctx> };

export interface SmppServerOptions<Ctx = unknown> {
  /** Hook d'authentification (obligatoire : sans lui, aucun bind n'est possible). */
  authenticate: Authenticate<Ctx>;
  handlers?: Handlers<Ctx>;
  /** Options TLS : leur présence active TLS. */
  tls?: tls.TlsOptions;
  /** system_id renvoyé dans bind_resp. Défaut : `smpp-ts`. */
  systemId?: string;

  /** Session ouverte mais non bindée fermée après ce délai. Défaut : 30 s. */
  bindTimeout?: number;
  /** Session bindée sans trafic fermée après ce délai. Défaut : 5 min. 0 = désactivé. */
  idleTimeout?: number;
  /** Délai max d'un handler avant réponse ESME_RSYSERR automatique. Défaut : 10 s. */
  handlerTimeout?: number;
  maxSessions?: number;
  maxSessionsPerIp?: number;
  maxSessionsPerSystemId?: number;
  bindFailures?: BindFailurePolicy;

  /** Proxy Protocol v1/v2. Désactivé par défaut. */
  proxyProtocol?: ProxyProtocolOptions;

  window?: number;
  maxQueueSize?: number;
  requestTimeout?: number;
  /** Envoi d'enquire_link par le serveur. Défaut : 0 (désactivé, le client s'en charge). */
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

/** Serveur SMPP (SMSC / simulateur). */
export class SmppServer<Ctx = unknown> extends EventEmitter<ServerEvents<Ctx>> {
  readonly sessions = new Set<ServerSession<Ctx>>();
  private readonly options: SmppServerOptions<Ctx>;
  private readonly logger: Logger;
  private readonly codec: PduCodec;
  private readonly server: net.Server;
  private readonly failures: BindFailureTracker;
  private readonly trusted: CidrList | undefined;
  private readonly secureContext: tls.SecureContext | undefined;
  private readonly perIp = new Map<string, number>();
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

  /** Démarre l'écoute. */
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

  /** Arrête l'écoute et ferme proprement toutes les sessions (unbind). */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled([...this.sessions].map((s) => s.close()));
    await closed;
  }

  /** Sessions bindées pour un system_id. */
  sessionsFor(systemId: string): ServerSession<Ctx>[] {
    return [...this.sessions].filter((s) => s.systemId === systemId && s.mode !== undefined);
  }

  /** Envoie un deliver_sm à une session receiver/transceiver du system_id (tourniquet). */
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

  // ---------------------------------------------------------------- connexions

  private reject(socket: net.Socket, ip: string, reason: string): void {
    this.logger.warn('connection rejected', { remoteAddress: ip, reason });
    this.emit('rejected', { remoteAddress: ip, reason });
    socket.destroy();
  }

  private admissible(ip: string): string | undefined {
    if (this.failures.isBanned(ip)) return 'banned after repeated bind failures';
    if (this.sessions.size >= (this.options.maxSessions ?? 1000)) return 'maxSessions reached';
    if ((this.perIp.get(ip) ?? 0) >= (this.options.maxSessionsPerIp ?? 50)) return 'maxSessionsPerIp reached';
    return undefined;
  }

  private async onConnection(socket: net.Socket): Promise<void> {
    socket.on('error', () => {}); // les erreurs sont gérées par la session ou la destruction
    let ip = normalizeIp(socket.remoteAddress ?? 'unknown');
    const early = this.admissible(ip);
    if (early) return this.reject(socket, ip, early);

    let stream: Duplex = socket;
    if (this.trusted) {
      const timeout = this.options.proxyProtocol?.headerTimeout ?? 5_000;
      if (this.trusted.has(ip)) {
        const header = await readProxyHeader(socket, timeout);
        if (header.command === 'PROXY' && header.sourceAddress) {
          ip = normalizeIp(header.sourceAddress);
          const late = this.admissible(ip);
          if (late) return this.reject(socket, ip, late);
        }
        // Les octets suivant l'en-tête ont été remis dans le flux : TLS doit lire via un flux JS.
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
          this.options.bindTimeout ?? 30_000,
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
      logContext: { remoteAddress: ip },
    });
    const ss = new ServerSession<Ctx>(session, ip);
    this.sessions.add(ss);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    // SEC-05 : une session non bindée est fermée après bindTimeout.
    const bindTimer = setTimeout(() => {
      if (ss.mode === undefined) {
        this.logger.warn('bind timeout, closing session', { remoteAddress: ip });
        session.destroy();
      }
    }, o.bindTimeout ?? 30_000);
    bindTimer.unref?.();

    session.on('pdu', (pdu) => {
      void this.onPdu(ss, pdu);
    });
    session.on('metric', (m) => {
      if (this.listenerCount('metric') > 0) this.emit('metric', m, ss);
    });
    session.on('error', (err) => this.emitError(err));
    session.on('close', () => {
      clearTimeout(bindTimer);
      this.sessions.delete(ss);
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
      this.emitSafe('sessionClose', ss);
    });
    this.emitSafe('session', ss);
    raw.resume();
    stream.resume();
  }

  // ---------------------------------------------------------------- PDU entrants

  private async onPdu(ss: ServerSession<Ctx>, pdu: Pdu): Promise<void> {
    const mode = bindModeOf(pdu.command);
    if (mode) return this.onBind(ss, pdu as PduOf<'bind_transceiver'>, mode);

    const command = pdu.command as HandledCommand;
    const handler = this.handlers[command] as Handler<HandledCommand, Ctx> | undefined;
    if (!responseNameOf(pdu.command)) {
      // Pas de réponse attendue : on notifie le handler éventuel.
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
      if (typeof result === 'number') ss.session.respond(req, { command_status: result });
      else ss.session.respond(req, (result ?? {}) as never);
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
    session.pause(); // ordre préservé pendant l'authentification asynchrone (REL-09)
    let accepted: boolean | Ctx = false;
    try {
      const perSystem = this.options.maxSessionsPerSystemId ?? 10;
      if (this.sessionsFor(pdu.system_id).length < perSystem) {
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

    if (session.isClosed) return;
    if (accepted === false || accepted === null || accepted === undefined) {
      // Même réponse que le system_id existe ou non (SEC-06).
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
    session.resume();
    this.logger.info('session bound', { systemId: pdu.system_id, remoteAddress: ip, mode });
    this.emitSafe('bind', ss);
  }

  // ---------------------------------------------------------------- utilitaires

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
