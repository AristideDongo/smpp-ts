import net from 'node:net';
import type { Socket } from 'node:net';
import { SmppError, SmppTimeoutError } from '../errors.js';

/**
 * Proxy Protocol v1 (text) and v2 (binary), built-in parser with no dependency (SEC-08).
 * Specification: https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt
 */

export interface ProxyHeader {
  version: 1 | 2;
  /** `LOCAL`: proxy health check connection, the socket address is kept. */
  command: 'PROXY' | 'LOCAL';
  family: 'TCP4' | 'TCP6' | 'UDP4' | 'UDP6' | 'UNIX' | 'UNKNOWN';
  sourceAddress?: string;
  sourcePort?: number;
  destinationAddress?: string;
  destinationPort?: number;
}

export type ProxyParseResult =
  | { status: 'complete'; header: ProxyHeader; consumed: number }
  | { status: 'incomplete' }
  | { status: 'invalid'; reason: string };

export const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
const V1_PREFIX = Buffer.from('PROXY ', 'latin1');
const V1_MAX_LENGTH = 107;

/** True when the buffer starts (or could start) with a Proxy Protocol header. */
export function looksLikeProxyHeader(buf: Buffer): boolean {
  const n = Math.min(buf.length, 6);
  if (n === 0) return false;
  return (
    buf.subarray(0, n).equals(V1_PREFIX.subarray(0, n)) ||
    buf.subarray(0, Math.min(buf.length, 12)).equals(PROXY_V2_SIGNATURE.subarray(0, Math.min(buf.length, 12)))
  );
}

function validPort(s: string): number | undefined {
  if (!/^\d{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n <= 65535 ? n : undefined;
}

function parseV1(buf: Buffer): ProxyParseResult {
  const end = buf.indexOf('\r\n', 0, 'latin1');
  if (end === -1) {
    return buf.length >= V1_MAX_LENGTH
      ? { status: 'invalid', reason: 'v1 header too long' }
      : { status: 'incomplete' };
  }
  if (end + 2 > V1_MAX_LENGTH) return { status: 'invalid', reason: 'v1 header too long' };
  const parts = buf.toString('latin1', 0, end).split(' ');
  if (parts[0] !== 'PROXY') return { status: 'invalid', reason: 'bad v1 prefix' };
  const family = parts[1];
  if (family === 'UNKNOWN') {
    return {
      status: 'complete',
      header: { version: 1, command: 'PROXY', family: 'UNKNOWN' },
      consumed: end + 2,
    };
  }
  if ((family !== 'TCP4' && family !== 'TCP6') || parts.length !== 6) {
    return { status: 'invalid', reason: 'bad v1 header' };
  }
  const [, , src, dst, sp, dp] = parts as [string, string, string, string, string, string];
  const ipVersion = family === 'TCP4' ? 4 : 6;
  const sourcePort = validPort(sp);
  const destinationPort = validPort(dp);
  if (
    net.isIP(src) !== ipVersion ||
    net.isIP(dst) !== ipVersion ||
    sourcePort === undefined ||
    destinationPort === undefined
  ) {
    return { status: 'invalid', reason: 'bad v1 addresses' };
  }
  return {
    status: 'complete',
    header: {
      version: 1,
      command: 'PROXY',
      family,
      sourceAddress: src,
      sourcePort,
      destinationAddress: dst,
      destinationPort,
    },
    consumed: end + 2,
  };
}

function ipv6ToString(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  // Canonical form through Node's parser (zero compression).
  const raw = groups.join(':');
  const sl = new net.SocketAddress({ address: raw, family: 'ipv6' });
  return sl.address;
}

function parseV2(buf: Buffer): ProxyParseResult {
  if (buf.length < 16) return { status: 'incomplete' };
  const verCmd = buf[12]!;
  if (verCmd >> 4 !== 2) return { status: 'invalid', reason: 'bad v2 version' };
  const cmd = verCmd & 0x0f;
  if (cmd > 1) return { status: 'invalid', reason: 'bad v2 command' };
  const famProto = buf[13]!;
  const len = buf.readUInt16BE(14);
  if (len > 2048) return { status: 'invalid', reason: 'v2 header too long' };
  if (buf.length < 16 + len) return { status: 'incomplete' };
  const body = buf.subarray(16, 16 + len);
  const consumed = 16 + len;
  const command = cmd === 0 ? 'LOCAL' : 'PROXY';
  const fam = famProto >> 4;
  const proto = famProto & 0x0f;
  if (command === 'LOCAL' || fam === 0) {
    return { status: 'complete', header: { version: 2, command, family: 'UNKNOWN' }, consumed };
  }
  const stream = proto === 1;
  if (fam === 1) {
    if (body.length < 12) return { status: 'invalid', reason: 'v2 IPv4 block too short' };
    return {
      status: 'complete',
      consumed,
      header: {
        version: 2,
        command,
        family: stream ? 'TCP4' : 'UDP4',
        sourceAddress: [...body.subarray(0, 4)].join('.'),
        destinationAddress: [...body.subarray(4, 8)].join('.'),
        sourcePort: body.readUInt16BE(8),
        destinationPort: body.readUInt16BE(10),
      },
    };
  }
  if (fam === 2) {
    if (body.length < 36) return { status: 'invalid', reason: 'v2 IPv6 block too short' };
    return {
      status: 'complete',
      consumed,
      header: {
        version: 2,
        command,
        family: stream ? 'TCP6' : 'UDP6',
        sourceAddress: ipv6ToString(body.subarray(0, 16)),
        destinationAddress: ipv6ToString(body.subarray(16, 32)),
        sourcePort: body.readUInt16BE(32),
        destinationPort: body.readUInt16BE(34),
      },
    };
  }
  return {
    status: 'complete',
    header: { version: 2, command, family: fam === 3 ? 'UNIX' : 'UNKNOWN' },
    consumed,
  };
}

/** Parses a Proxy Protocol v1 or v2 header at the start of a buffer. Never throws. */
export function parseProxyHeader(buf: Buffer): ProxyParseResult {
  try {
    if (buf.length === 0) return { status: 'incomplete' };
    if (buf[0] === 0x50) {
      const n = Math.min(buf.length, 6);
      if (!buf.subarray(0, n).equals(V1_PREFIX.subarray(0, n)))
        return { status: 'invalid', reason: 'not a proxy header' };
      if (buf.length < 6) return { status: 'incomplete' };
      return parseV1(buf);
    }
    const n = Math.min(buf.length, 12);
    if (!buf.subarray(0, n).equals(PROXY_V2_SIGNATURE.subarray(0, n)))
      return { status: 'invalid', reason: 'not a proxy header' };
    if (buf.length < 12) return { status: 'incomplete' };
    return parseV2(buf);
  } catch {
    return { status: 'invalid', reason: 'malformed header' };
  }
}

/** Normalizes an IPv4-mapped IPv6 address (`::ffff:1.2.3.4` → `1.2.3.4`). */
export function normalizeIp(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m ? m[1]! : address;
}

/** List of trusted CIDRs (IPv4 and IPv6), backed by `net.BlockList`. */
export class CidrList {
  private readonly list = new net.BlockList();
  readonly size: number;

  constructor(cidrs: readonly string[]) {
    for (const entry of cidrs) {
      const [addr, prefixStr] = entry.split('/');
      const ip = normalizeIp(addr ?? '');
      const version = net.isIP(ip);
      if (version === 0) throw new SmppError('SMPP_CONFIG', `Invalid CIDR: ${entry}`);
      const type = version === 4 ? 'ipv4' : 'ipv6';
      const prefix = prefixStr === undefined ? (version === 4 ? 32 : 128) : Number(prefixStr);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
        throw new SmppError('SMPP_CONFIG', `Invalid CIDR prefix: ${entry}`);
      }
      this.list.addSubnet(ip, prefix, type);
    }
    this.size = cidrs.length;
  }

  has(address: string | undefined): boolean {
    if (!address) return false;
    const ip = normalizeIp(address);
    const version = net.isIP(ip);
    if (version === 0) return false;
    return this.list.check(ip, version === 4 ? 'ipv4' : 'ipv6');
  }
}

export interface ProxyProtocolOptions {
  /** Trusted proxy CIDRs (required). */
  trustedProxies: readonly string[];
  /** Header read timeout. Default: 5 s. */
  headerTimeout?: number;
}

/**
 * Reads the Proxy Protocol header of a socket coming from a trusted proxy.
 * Bytes after the header are pushed back into the stream (`unshift`). The socket is left paused.
 */
export function readProxyHeader(socket: Socket, timeoutMs = 5_000): Promise<ProxyHeader> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new SmppTimeoutError('proxy_header', timeoutMs)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const res = parseProxyHeader(buf);
      if (res.status === 'incomplete') return;
      if (res.status === 'invalid')
        return finish(new SmppError('SMPP_PROXY_PROTOCOL', `Invalid PROXY header: ${res.reason}`));
      finish(undefined, res.header, buf.subarray(res.consumed));
    };
    const onClose = () =>
      finish(new SmppError('SMPP_PROXY_PROTOCOL', 'Connection closed before PROXY header'));
    const finish = (err?: Error, header?: ProxyHeader, rest?: Buffer) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.pause();
      if (err) return reject(err);
      if (rest && rest.length > 0) socket.unshift(rest);
      resolve(header!);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.resume();
  });
}

/**
 * Reads the first chunk of a direct (untrusted) connection to reject any
 * spoofed Proxy Protocol header. The bytes read are pushed back into the stream.
 */
export function rejectSpoofedProxyHeader(socket: Socket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), timeoutMs);
    const onData = (chunk: Buffer) => finish(chunk);
    const onClose = () => finish();
    const finish = (chunk?: Buffer) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.pause();
      if (chunk && looksLikeProxyHeader(chunk)) {
        return reject(
          new SmppError('SMPP_PROXY_PROTOCOL', 'PROXY header received from an untrusted address'),
        );
      }
      if (chunk) socket.unshift(chunk);
      resolve();
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.resume();
  });
}
