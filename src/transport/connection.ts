import net from 'node:net';
import tls from 'node:tls';
import { SmppError, SmppTimeoutError, toError } from '../errors.js';
import { type Logger, silentLogger } from '../logger.js';

export const DEFAULT_PORT = 2775;
export const DEFAULT_TLS_PORT = 3550;

export interface Endpoint {
  host: string;
  port: number;
  tls: boolean;
}

/** TLS client options. Certificate verification is on by default (SEC-01). */
export interface TlsClientOptions {
  /** Extra certificate authorities, for an SMSC with a self-signed certificate. */
  ca?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer;
  key?: string | Buffer;
  passphrase?: string;
  /**
   * Server certificate verification. Default: **true**.
   * Disabling it exposes the bind credentials to man-in-the-middle attacks.
   */
  rejectUnauthorized?: boolean;
  checkServerIdentity?: (hostname: string, cert: tls.PeerCertificate) => Error | undefined;
  /** Minimum TLS version. Default: TLSv1.2. */
  minVersion?: tls.SecureVersion;
  /** SNI name. Default: the host. */
  servername?: string;
}

/** Parses a `smpp://host:port` or `ssmpp://host:port` URL (WHATWG URL API). */
export function parseSmppUrl(url: string): Endpoint {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SmppError('SMPP_CONFIG', `Invalid SMPP URL: ${url}`);
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme !== 'smpp' && scheme !== 'ssmpp') {
    throw new SmppError('SMPP_CONFIG', `Unsupported URL scheme "${scheme}" (expected smpp or ssmpp)`);
  }
  if (u.username || u.password) {
    throw new SmppError('SMPP_CONFIG', 'Credentials must be passed in bind options, not in the URL');
  }
  const isTls = scheme === 'ssmpp';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SmppError('SMPP_CONFIG', `Missing host in SMPP URL: ${url}`);
  return { host, port: u.port ? Number(u.port) : isTls ? DEFAULT_TLS_PORT : DEFAULT_PORT, tls: isTls };
}

/** Builds TLS options with safe defaults (SEC-01). */
export function buildTlsOptions(
  endpoint: Endpoint,
  options: TlsClientOptions = {},
  logger: Logger = silentLogger,
): tls.ConnectionOptions {
  const rejectUnauthorized = options.rejectUnauthorized ?? true;
  if (!rejectUnauthorized) {
    logger.warn(
      'TLS certificate verification is DISABLED (rejectUnauthorized: false): the connection is vulnerable to man-in-the-middle attacks. Prefer the `tls.ca` option.',
      { host: endpoint.host },
    );
  }
  const out: tls.ConnectionOptions = {
    host: endpoint.host,
    port: endpoint.port,
    rejectUnauthorized,
    minVersion: options.minVersion ?? 'TLSv1.2',
  };
  if (!net.isIP(endpoint.host) || options.servername) out.servername = options.servername ?? endpoint.host;
  if (options.ca !== undefined) out.ca = options.ca;
  if (options.cert !== undefined) out.cert = options.cert;
  if (options.key !== undefined) out.key = options.key;
  if (options.passphrase !== undefined) out.passphrase = options.passphrase;
  if (options.checkServerIdentity) out.checkServerIdentity = options.checkServerIdentity;
  return out;
}

export interface ConnectOptions {
  /** Default: 10 s. */
  connectTimeout?: number;
  tls?: TlsClientOptions;
  logger?: Logger;
}

/** Opens a TCP or TLS connection with a timeout. */
export function connectSocket(endpoint: Endpoint, options: ConnectOptions = {}): Promise<net.Socket> {
  const timeoutMs = options.connectTimeout ?? 10_000;
  return new Promise((resolve, reject) => {
    const socket: net.Socket = endpoint.tls
      ? tls.connect(buildTlsOptions(endpoint, options.tls, options.logger))
      : net.connect({ host: endpoint.host, port: endpoint.port });
    const readyEvent = endpoint.tls ? 'secureConnect' : 'connect';

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new SmppTimeoutError('connect', timeoutMs, `connect to ${endpoint.host}:${endpoint.port}`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      resolve(socket);
    };
    const onError = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(
        new SmppError(
          'SMPP_CONNECT',
          `Cannot connect to ${endpoint.host}:${endpoint.port}: ${toError(err).message}`,
          { cause: err },
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(readyEvent, onReady);
      socket.off('error', onError);
    };
    socket.once(readyEvent, onReady);
    socket.once('error', onError);
  });
}
