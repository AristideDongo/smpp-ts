import { describe, expect, it, vi } from 'vitest';
import { REDACTED, maskNumber, pinoAdapter, redactPdu } from '../../src/logger.js';
import { buildTlsOptions, parseSmppUrl } from '../../src/transport/connection.js';
import {
  CidrList,
  PROXY_V2_SIGNATURE,
  looksLikeProxyHeader,
  normalizeIp,
  parseProxyHeader,
} from '../../src/transport/proxy-protocol.js';

describe('URL parsing', () => {
  it('parses smpp and ssmpp URLs with default ports', () => {
    expect(parseSmppUrl('smpp://smsc.example.com')).toEqual({
      host: 'smsc.example.com',
      port: 2775,
      tls: false,
    });
    expect(parseSmppUrl('ssmpp://smsc.example.com:3551')).toEqual({
      host: 'smsc.example.com',
      port: 3551,
      tls: true,
    });
    expect(parseSmppUrl('ssmpp://smsc.example.com').port).toBe(3550);
    expect(parseSmppUrl('smpp://[::1]:2775').host).toBe('::1');
  });

  it('rejects other schemes, credentials in URL and garbage', () => {
    expect(() => parseSmppUrl('http://x')).toThrow(/scheme/);
    expect(() => parseSmppUrl('smpp://user:pass@x')).toThrow(/Credentials/);
    expect(() => parseSmppUrl('not a url')).toThrow(/Invalid/);
  });
});

describe('TLS defaults (SEC-01)', () => {
  const ep = { host: 'smsc.example.com', port: 3550, tls: true };

  it('verifies certificates and requires TLS 1.2 by default', () => {
    const o = buildTlsOptions(ep);
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.minVersion).toBe('TLSv1.2');
    expect(o.servername).toBe('smsc.example.com');
  });

  it('passes ca and checkServerIdentity through', () => {
    const check = () => undefined;
    const o = buildTlsOptions(ep, { ca: 'PEM', checkServerIdentity: check, minVersion: 'TLSv1.3' });
    expect(o.ca).toBe('PEM');
    expect(o.checkServerIdentity).toBe(check);
    expect(o.minVersion).toBe('TLSv1.3');
  });

  it('warns loudly when verification is disabled', () => {
    const warn = vi.fn();
    const o = buildTlsOptions(ep, { rejectUnauthorized: false }, { debug() {}, info() {}, warn, error() {} });
    expect(o.rejectUnauthorized).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/DISABLED/);
  });

  it('does not set SNI for IP addresses', () => {
    expect(buildTlsOptions({ host: '10.0.0.1', port: 1, tls: true }).servername).toBeUndefined();
  });
});

describe('redaction (SEC-02)', () => {
  const pdu = {
    command: 'bind_transceiver',
    system_id: 'acme',
    password: 'hunter2',
    source_addr: '2250700000000',
    short_message: Buffer.from('Votre code est 123456'),
    message_payload: Buffer.from('x'),
    nested: { password: 'deep' },
  };

  it('always masks passwords, even nested', () => {
    const r = redactPdu(pdu);
    expect(r.password).toBe(REDACTED);
    expect((r.nested as Record<string, unknown>).password).toBe(REDACTED);
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(r.source_addr).toBe('2250700000000');
  });

  it('masks content and numbers on demand', () => {
    const r = redactPdu(pdu, { redactContent: true, redactNumbers: true });
    expect(r.short_message).toBe(REDACTED);
    expect(r.message_payload).toBe(REDACTED);
    expect(r.source_addr).toBe('2250*******00');
    expect(JSON.stringify(r)).not.toContain('123456');
  });

  it('maskNumber', () => {
    expect(maskNumber('123')).toBe('***');
    expect(maskNumber('1234567')).toBe('1234*67');
  });

  it('pinoAdapter swaps arguments', () => {
    const info = vi.fn();
    const l = pinoAdapter({ debug() {}, info, warn() {}, error() {} });
    l.info('hello', { a: 1 });
    expect(info).toHaveBeenCalledWith({ a: 1 }, 'hello');
  });
});

describe('Proxy Protocol parser (SEC-08)', () => {
  it('parses v1 TCP4 and leaves the rest', () => {
    const buf = Buffer.from('PROXY TCP4 192.168.0.1 10.0.0.1 56324 2775\r\nREST', 'latin1');
    const r = parseProxyHeader(buf);
    expect(r).toMatchObject({
      status: 'complete',
      header: {
        version: 1,
        family: 'TCP4',
        sourceAddress: '192.168.0.1',
        sourcePort: 56324,
        destinationPort: 2775,
      },
    });
    if (r.status === 'complete') expect(buf.subarray(r.consumed).toString()).toBe('REST');
  });

  it('parses v1 TCP6 and UNKNOWN', () => {
    expect(parseProxyHeader(Buffer.from('PROXY TCP6 ::1 ::2 1 2\r\n'))).toMatchObject({
      status: 'complete',
      header: { family: 'TCP6' },
    });
    expect(parseProxyHeader(Buffer.from('PROXY UNKNOWN\r\n'))).toMatchObject({
      status: 'complete',
      header: { family: 'UNKNOWN' },
    });
  });

  it('reports incomplete and invalid v1 headers', () => {
    expect(parseProxyHeader(Buffer.from('PROX'))).toEqual({ status: 'incomplete' });
    expect(parseProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4'))).toEqual({ status: 'incomplete' });
    expect(parseProxyHeader(Buffer.from('PROXY TCP4 999.1.1.1 1.1.1.1 1 2\r\n')).status).toBe('invalid');
    expect(parseProxyHeader(Buffer.from('PROXY TCP4 1.1.1.1 1.1.1.1 1 99999\r\n')).status).toBe('invalid');
    expect(parseProxyHeader(Buffer.from(`PROXY ${'x'.repeat(120)}`)).status).toBe('invalid');
    expect(parseProxyHeader(Buffer.from('HELLO')).status).toBe('invalid');
  });

  it('parses v2 IPv4 and IPv6', () => {
    const v4 = Buffer.concat([
      PROXY_V2_SIGNATURE,
      Buffer.from([0x21, 0x11, 0x00, 0x0c]),
      Buffer.from([192, 168, 1, 10, 10, 0, 0, 1, 0x1f, 0x90, 0x0a, 0xd7]),
      Buffer.from('X'),
    ]);
    const r = parseProxyHeader(v4);
    expect(r).toMatchObject({
      status: 'complete',
      consumed: 28,
      header: {
        version: 2,
        command: 'PROXY',
        family: 'TCP4',
        sourceAddress: '192.168.1.10',
        sourcePort: 8080,
        destinationPort: 2775,
      },
    });

    const addr6 = Buffer.alloc(36);
    addr6[15] = 1;
    addr6[31] = 2;
    const v6 = Buffer.concat([PROXY_V2_SIGNATURE, Buffer.from([0x21, 0x21, 0x00, 36]), addr6]);
    const r6 = parseProxyHeader(v6);
    expect(r6.status).toBe('complete');
    if (r6.status === 'complete') {
      expect(new CidrList(['::1/128']).has(r6.header.sourceAddress)).toBe(true);
    }
  });

  it('parses v2 LOCAL and rejects bad versions', () => {
    const local = Buffer.concat([PROXY_V2_SIGNATURE, Buffer.from([0x20, 0x00, 0x00, 0x00])]);
    expect(parseProxyHeader(local)).toMatchObject({ status: 'complete', header: { command: 'LOCAL' } });
    const bad = Buffer.concat([PROXY_V2_SIGNATURE, Buffer.from([0x31, 0x11, 0x00, 0x00])]);
    expect(parseProxyHeader(bad).status).toBe('invalid');
    expect(parseProxyHeader(PROXY_V2_SIGNATURE.subarray(0, 5))).toEqual({ status: 'incomplete' });
  });

  it('detects headers for spoofing checks', () => {
    expect(looksLikeProxyHeader(Buffer.from('PRO'))).toBe(true);
    expect(looksLikeProxyHeader(PROXY_V2_SIGNATURE.subarray(0, 3))).toBe(true);
    expect(looksLikeProxyHeader(Buffer.from([0, 0, 0, 16]))).toBe(false);
  });
});

describe('CidrList', () => {
  it('matches IPv4, IPv6 and IPv4-mapped addresses', () => {
    const l = new CidrList(['10.0.0.0/8', '192.168.1.5', 'fd00::/8']);
    expect(l.has('10.20.30.40')).toBe(true);
    expect(l.has('::ffff:10.1.1.1')).toBe(true);
    expect(l.has('192.168.1.5')).toBe(true);
    expect(l.has('192.168.1.6')).toBe(false);
    expect(l.has('fd12::1')).toBe(true);
    expect(l.has(undefined)).toBe(false);
    expect(l.has('garbage')).toBe(false);
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('rejects invalid CIDRs', () => {
    expect(() => new CidrList(['nope'])).toThrow();
    expect(() => new CidrList(['10.0.0.0/40'])).toThrow();
  });
});
