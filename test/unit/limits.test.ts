import { describe, expect, it } from 'vitest';
import { PduCodec } from '../../src/codec/pdu.js';
import { SmppValidationError } from '../../src/errors.js';
import { COMMAND_STATUS } from '../../src/protocol/status.js';
import { BindFailureTracker } from '../../src/server/auth.js';
import { ConnectionRateLimiter } from '../../src/server/limits.js';
import { Reassembler, type ReassemblySegment } from '../../src/utils/multipart.js';

function segment(
  ref: number,
  sequence: number,
  total: number,
  bytes: number,
): ReassemblySegment<{ id: string }> {
  return {
    source: 'S',
    destination: 'D',
    concat: { reference: ref, total, sequence },
    body: Buffer.alloc(bytes, 0x41),
    dataCoding: 0,
    meta: { id: `${ref}/${sequence}` },
  };
}

describe('Reassembler: octet budget (SEC-04)', () => {
  it('bounds the content held, whatever maxBuffers allows', () => {
    const partials: number[] = [];
    const r = new Reassembler<{ id: string }>({
      maxBuffers: 1000,
      maxBytes: 4096,
      onPartial: (m) => partials.push(m.reference),
    });
    // 20 incomplete messages of 1 KiB: the budget allows four of them.
    for (let ref = 1; ref <= 20; ref++) r.add(segment(ref, 1, 4, 1024));
    expect(r.bytes).toBeLessThanOrEqual(4096);
    expect(r.size).toBeLessThanOrEqual(4);
    // Evicted buffers are reported, oldest first, so nothing disappears silently.
    expect(partials.length).toBe(16);
    expect(partials[0]).toBe(1);
  });

  it('never evicts the buffer the incoming segment belongs to', () => {
    const r = new Reassembler({ maxBytes: 100 });
    expect(r.add(segment(1, 1, 2, 500))).toBeUndefined();
    expect(r.size).toBe(1); // over budget but kept: evicting it would drop the segment just received
    expect(r.bytes).toBe(500);
    // Its sibling still completes the message, and the buffer is released.
    const done = r.add(segment(1, 2, 2, 500));
    expect(done?.body.length).toBe(1000);
    expect(r.size).toBe(0);
    expect(r.bytes).toBe(0);
  });

  it('counts a replaced duplicate segment only once', () => {
    const r = new Reassembler({ maxBytes: 0 });
    r.add(segment(7, 1, 3, 100));
    r.add(segment(7, 1, 3, 100));
    expect(r.bytes).toBe(100);
    r.clear();
    expect(r.bytes).toBe(0);
  });

  it('maxBytes: 0 disables the budget', () => {
    const r = new Reassembler({ maxBytes: 0 });
    for (let ref = 1; ref <= 50; ref++) r.add(segment(ref, 1, 2, 1024));
    expect(r.size).toBe(50);
    expect(r.bytes).toBe(50 * 1024);
  });
});

describe('BindFailureTracker: hard cap on tracked addresses', () => {
  it('drops the oldest entries instead of growing without limit', () => {
    let now = 1_000;
    const t = new BindFailureTracker({ maxAttempts: 1, banMs: 60_000, maxEntries: 10 }, () => now);
    for (let i = 0; i < 100; i++) {
      now += 1;
      t.recordFailure(`10.0.0.${i}`);
    }
    expect(t.size).toBeLessThanOrEqual(10);
    // The most recent bans survive, the oldest are forgotten.
    expect(t.isBanned('10.0.0.99')).toBe(true);
    expect(t.isBanned('10.0.0.0')).toBe(false);
  });

  it('still prunes expired entries first', () => {
    let now = 0;
    const t = new BindFailureTracker({ maxAttempts: 5, windowMs: 10, maxEntries: 4 }, () => now);
    t.recordFailure('a');
    now = 1_000; // 'a' is out of the counting window
    for (const ip of ['b', 'c', 'd']) t.recordFailure(ip);
    expect(t.size).toBe(3);
  });
});

describe('ConnectionRateLimiter', () => {
  it('limits the rate per address and keeps the burst', () => {
    let now = 0;
    const limiter = new ConnectionRateLimiter({ perIpPerSecond: 10, perIpBurst: 3 }, () => now);
    expect(limiter.check('1.2.3.4')).toBe('ok');
    expect(limiter.check('1.2.3.4')).toBe('ok');
    expect(limiter.check('1.2.3.4')).toBe('ok');
    expect(limiter.check('1.2.3.4')).toBe('ip-rate');
    // Another address has its own bucket.
    expect(limiter.check('5.6.7.8')).toBe('ok');
    now += 100; // one token per 100 ms at 10/s
    expect(limiter.check('1.2.3.4')).toBe('ok');
    expect(limiter.check('1.2.3.4')).toBe('ip-rate');
  });

  it('applies a total limit on top of the per-address one', () => {
    let now = 0;
    const limiter = new ConnectionRateLimiter({ perIpPerSecond: 1000, perSecond: 5, burst: 2 }, () => now);
    expect(limiter.check('a')).toBe('ok');
    expect(limiter.check('b')).toBe('ok');
    expect(limiter.check('c')).toBe('total-rate');
    now += 1000;
    expect(limiter.check('c')).toBe('ok');
  });

  it('bounds the addresses it tracks', () => {
    let now = 0;
    const limiter = new ConnectionRateLimiter({ perIpPerSecond: 1, perIpBurst: 1, maxTracked: 8 }, () => now);
    for (let i = 0; i < 200; i++) {
      now += 1;
      limiter.check(`10.1.0.${i}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(8);
  });

  it('perIpPerSecond: 0 accepts everything', () => {
    const limiter = new ConnectionRateLimiter({ perIpPerSecond: 0 });
    for (let i = 0; i < 100; i++) expect(limiter.check('1.1.1.1')).toBe('ok');
    expect(limiter.size).toBe(0);
  });
});

describe('validateEnums (SEC-03)', () => {
  const codec = new PduCodec({ validateEnums: true });

  it('refuses an out-of-spec TON with the matching status', () => {
    const err = (() => {
      try {
        codec.encode({ command: 'submit_sm', destination_addr: '2250700000000', dest_addr_ton: 9 });
      } catch (e) {
        return e as SmppValidationError;
      }
    })();
    expect(err).toBeInstanceOf(SmppValidationError);
    expect(err?.field).toBe('dest_addr_ton');
    expect(err?.status).toBe(COMMAND_STATUS.ESME_RINVDSTTON);
  });

  it('refuses an unknown data_coding, an out-of-range priority and a reserved esm_class', () => {
    expect(() => codec.encode({ command: 'submit_sm', data_coding: 0x42 })).toThrow(/data_coding/);
    expect(() => codec.encode({ command: 'submit_sm', priority_flag: 7 })).toThrow(/priority_flag/);
    expect(() => codec.encode({ command: 'submit_sm', esm_class: 0x0c })).toThrow(/esm_class/);
    expect(() => codec.encode({ command: 'submit_sm', registered_delivery: 0x40 })).toThrow(
      /registered_delivery/,
    );
  });

  it('accepts the values the library itself produces', () => {
    expect(() =>
      codec.encode({
        command: 'submit_sm',
        source_addr_ton: 5,
        source_addr_npi: 0,
        dest_addr_ton: 1,
        dest_addr_npi: 1,
        data_coding: 0x18, // UCS2 flash
        esm_class: 0x40, // UDH indicator
        registered_delivery: 0x01,
        priority_flag: 3,
      }),
    ).not.toThrow();
    // Kannel's 0x43 keeps a valid message type (bits 5-2 are zero).
    expect(() => codec.encode({ command: 'deliver_sm', esm_class: 0x43 })).not.toThrow();
  });

  it('checks submit_multi destinations too', () => {
    expect(() =>
      codec.encode({
        command: 'submit_multi',
        dest_address: [{ dest_flag: 1, dest_addr_ton: 9, dest_addr_npi: 1, destination_addr: '1' }],
      }),
    ).toThrow(/dest_addr_ton/);
  });

  it('is off by default, and never applies to decoding', () => {
    const lenient = new PduCodec();
    const buf = lenient.encode({ command: 'submit_sm', dest_addr_ton: 9, data_coding: 0x42 });
    expect(() => codec.decode(buf)).not.toThrow();
    expect(codec.decode(buf)).toMatchObject({ dest_addr_ton: 9, data_coding: 0x42 });
  });
});
