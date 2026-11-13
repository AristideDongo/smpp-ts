import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { Framer } from '../codec/framer.js';
import { PduCodec, type PduOf } from '../codec/pdu.js';
import { SmppError, SmppTimeoutError, toError } from '../errors.js';
import { type Logger, silentLogger } from '../logger.js';
import type { BindMode } from '../session/state-machine.js';
import { type BindOptions, type ClientSocket, SmppClient, type SmppClientOptions } from './client.js';

/** What the SMSC sent in its `outbind`, with where it came from. */
export interface OutbindInfo {
  system_id: string;
  password: string;
  remoteAddress: string;
  remotePort: number;
}

/** Why an incoming connection was not turned into a bound client. */
export type OutbindRejection = 'limit' | 'timeout' | 'protocol' | 'credentials' | 'bind' | 'tls';

export interface OutbindServerOptions {
  /**
   * Checks the credentials the SMSC presents in its `outbind` (SEC-06: use `safeCompare`).
   * `true` accepts; anything else refuses and closes the connection.
   */
  authenticate: (info: OutbindInfo) => boolean | Promise<boolean>;
  /**
   * Options of the client bound on each accepted connection. `bind.mode` is `receiver` by
   * default (the mode the specification associates with outbind).
   */
  client: Omit<SmppClientOptions, 'url' | 'host' | 'port' | 'tls' | 'socket' | 'reconnect' | 'bind'> & {
    bind: Omit<BindOptions, 'mode'> & { mode?: BindMode };
  };
  /** TLS server options (certificate and key). The SMSC then connects with `ssmpp://`. */
  tls?: tls.TlsOptions;
  /** Time for the SMSC to send its `outbind` after connecting. Default: 10 s. */
  outbindTimeout?: number;
  /** TLS handshake timeout. Default: 10 s. */
  handshakeTimeout?: number;
  /** Bound clients at the same time. Default: 10. */
  maxSessions?: number;
  logger?: Logger;
}

export interface OutbindServerEvents {
  listening: [address: net.AddressInfo];
  /** A connection passed `authenticate` and the client is bound: it sends and receives as usual. */
  session: [client: SmppClient, info: OutbindInfo];
  rejected: [reason: OutbindRejection, remoteAddress: string, error?: Error];
  error: [error: SmppError];
  close: [];
}

/**
 * Receives connections from an SMSC that initiates the session (SMPP `outbind`, section 2.2
 * of the specification): the SMSC connects, sends `outbind` with credentials, and the ESME
 * answers with `bind_receiver`. Each accepted connection becomes a bound `SmppClient` given to
 * the `session` event, with the usual events (`deliveryReport`, `message`…) and `close()`.
 *
 * ```ts
 * const outbind = new OutbindServer({
 *   authenticate: ({ system_id, password }) => system_id === 'smsc' && safeCompare(password, 'secret'),
 *   client: { bind: { mode: 'receiver', system_id: 'acme', password: 'xyz' } },
 * });
 * outbind.on('session', (client) => client.on('message', (m) => console.log(m.text)));
 * await outbind.listen(2775);
 * ```
 */
export class OutbindServer extends EventEmitter<OutbindServerEvents> {
  private readonly server: net.Server;
  private readonly logger: Logger;
  private readonly codec: PduCodec;
  private readonly secureContext: tls.SecureContext | undefined;
  private readonly clients = new Set<SmppClient>();
  private readonly pending = new Set<Duplex>();
  private closed = false;

  constructor(private readonly options: OutbindServerOptions) {
    super();
    this.logger = options.logger ?? silentLogger;
    this.codec = new PduCodec(options.client.codec);
    if (!options.client.bind?.system_id || options.client.bind.password === undefined) {
      throw new SmppError('SMPP_CONFIG', 'client.bind.system_id and client.bind.password are required');
    }
    if (options.tls) this.secureContext = tls.createSecureContext({ minVersion: 'TLSv1.2', ...options.tls });
    this.server = net.createServer({ pauseOnConnect: true }, (socket) => {
      this.onConnection(socket).catch((err: unknown) => {
        this.logger.warn('outbind connection failed', { error: toError(err).message });
        socket.destroy();
      });
    });
    this.server.on('error', (err) =>
      this.emitError(new SmppError('SMPP_SERVER', err.message, { cause: err })),
    );
  }

  listen(port = 2775, host?: string): Promise<net.AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.off('error', onError);
        const addr = this.server.address() as net.AddressInfo;
        this.logger.info('outbind server listening', { port: addr.port, address: addr.address });
        this.emit('listening', addr);
        resolve(addr);
      });
    });
  }

  get address(): net.AddressInfo | undefined {
    return (this.server.address() as net.AddressInfo | null) ?? undefined;
  }

  /** Clients currently bound. */
  get sessions(): ReadonlySet<SmppClient> {
    return this.clients;
  }

  /** Stops listening and closes every client (`drain: true` waits for in-flight requests). */
  async close(options: { drain?: boolean; timeout?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // `server.close` completes once every connection is gone: the clients close first.
    const stopped = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const s of this.pending) s.destroy();
    await Promise.allSettled([...this.clients].map((c) => c.close(options)));
    await stopped;
    this.emit('close');
  }

  private async onConnection(socket: net.Socket): Promise<void> {
    const remoteAddress = socket.remoteAddress ?? '';
    const remotePort = socket.remotePort ?? 0;
    if (this.clients.size + this.pending.size >= (this.options.maxSessions ?? 10)) {
      this.reject('limit', remoteAddress);
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    let stream: ClientSocket = socket;
    this.pending.add(socket);
    try {
      if (this.secureContext) {
        try {
          stream = await this.handshake(socket);
        } catch (err) {
          this.reject('tls', remoteAddress, toError(err));
          socket.destroy();
          return;
        }
      } else {
        socket.resume();
      }
      let outbind: PduOf<'outbind'>;
      try {
        outbind = await this.readOutbind(stream);
      } catch (err) {
        const e = toError(err);
        this.reject(e instanceof SmppTimeoutError ? 'timeout' : 'protocol', remoteAddress, e);
        stream.destroy();
        return;
      }
      const info: OutbindInfo = {
        system_id: outbind.system_id,
        password: outbind.password,
        remoteAddress,
        remotePort,
      };
      let accepted = false;
      try {
        accepted = (await this.options.authenticate(info)) === true;
      } catch (err) {
        this.logger.error('outbind authenticate failed', { error: toError(err).message, remoteAddress });
      }
      if (!accepted || this.closed) {
        // Same outcome whatever the reason: no hint on which system_id exists (SEC-06).
        this.reject('credentials', remoteAddress);
        stream.destroy();
        return;
      }
      const client = new SmppClient({
        ...this.options.client,
        bind: { ...this.options.client.bind, mode: this.options.client.bind.mode ?? 'receiver' },
        socket: stream,
        logger: this.logger,
      });
      // The application's listeners are attached on `session`: nothing is lost before that, the client
      // only starts emitting traffic after the bind.
      client.on('error', (err) =>
        this.logger.error('outbind client error', { error: err.message, remoteAddress }),
      );
      try {
        await client.connect();
      } catch (err) {
        this.reject('bind', remoteAddress, toError(err));
        stream.destroy();
        return;
      }
      this.pending.delete(socket);
      this.clients.add(client);
      client.once('close', () => this.clients.delete(client));
      this.logger.info('outbind session bound', { systemId: info.system_id, remoteAddress });
      this.emit('session', client, info);
    } finally {
      this.pending.delete(socket);
    }
  }

  private handshake(socket: net.Socket): Promise<tls.TLSSocket> {
    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext: this.secureContext,
      requestCert: Boolean(this.options.tls?.requestCert),
      rejectUnauthorized: this.options.tls?.rejectUnauthorized ?? true,
    });
    tlsSocket.on('error', () => tlsSocket.destroy());
    socket.resume();
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new SmppError('SMPP_TLS', 'TLS handshake timeout')),
        this.options.handshakeTimeout ?? 10_000,
      );
      tlsSocket.once('secure', () => {
        clearTimeout(t);
        resolve(tlsSocket);
      });
      tlsSocket.once('close', () => {
        clearTimeout(t);
        reject(new SmppError('SMPP_TLS', 'TLS handshake failed'));
      });
    });
  }

  /** Reads the first PDU, which must be an `outbind`; bytes after it are given back to the stream. */
  private readOutbind(stream: Duplex): Promise<PduOf<'outbind'>> {
    const timeoutMs = this.options.outbindTimeout ?? 10_000;
    const framer = new Framer(this.codec.maxPduLength);
    return new Promise((resolve, reject) => {
      let received = 0;
      const finish = (err?: Error, pdu?: PduOf<'outbind'>) => {
        clearTimeout(timer);
        stream.off('data', onData);
        stream.off('close', onClose);
        stream.off('error', onClose);
        if (err) reject(err);
        else resolve(pdu as PduOf<'outbind'>);
      };
      const timer = setTimeout(
        () => finish(new SmppTimeoutError('bind', timeoutMs, 'waiting for outbind')),
        timeoutMs,
      );
      const onClose = () => finish(new SmppError('SMPP_CONNECT', 'Connection closed before outbind'));
      const onData = (chunk: Buffer) => {
        received += chunk.length;
        const { frames, error } = framer.push(chunk);
        if (error) return finish(error);
        const frame = frames[0];
        if (!frame) return;
        let pdu: ReturnType<PduCodec['decode']>;
        try {
          pdu = this.codec.decode(frame);
        } catch (err) {
          return finish(toError(err));
        }
        if (pdu.command !== 'outbind') {
          return finish(new SmppError('SMPP_PROTOCOL', `Expected outbind, got ${pdu.command}`));
        }
        // Anything after the outbind (the SMSC should wait for the bind) goes back to the stream
        // for the session: the framer kept the bytes of the frames not consumed here.
        const rest = chunk.subarray(chunk.length - (received - frame.length));
        stream.pause();
        if (rest.length > 0) stream.unshift(rest);
        finish(undefined, pdu as PduOf<'outbind'>);
      };
      stream.on('data', onData);
      stream.once('close', onClose);
      stream.once('error', onClose);
    });
  }

  private reject(reason: OutbindRejection, remoteAddress: string, error?: Error): void {
    this.logger.warn('outbind rejected', {
      reason,
      remoteAddress,
      ...(error ? { error: error.message } : {}),
    });
    if (error) this.emit('rejected', reason, remoteAddress, error);
    else this.emit('rejected', reason, remoteAddress);
  }

  private emitError(err: SmppError): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.logger.error(err.message, { code: err.code });
  }
}
