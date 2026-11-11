/**
 * Parser fuzzing: no input, even malicious, may throw anything other than a SmppDecodeError.
 * 20 000 iterations per property by default; `npm run fuzz` runs 1 000 000.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Framer } from '../../src/codec/framer.js';
import { PduCodec, decodePdu, encodePdu } from '../../src/codec/pdu.js';
import { SmppDecodeError } from '../../src/errors.js';
import { COMMANDS } from '../../src/protocol/commands.js';
import { parseProxyHeader } from '../../src/transport/proxy-protocol.js';
import { parseDlr } from '../../src/utils/dlr.js';
import { decodeMessageContent, parseUdh } from '../../src/utils/multipart.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 20_000);

/**
 * Runs a property in batches of 50 000 iterations, yielding between batches:
 * a one-million-iteration run does not block the Vitest worker.
 */
async function assertInBatches<T>(property: fc.IProperty<T>, runs: number): Promise<void> {
  const batch = 50_000;
  for (let done = 0; done < runs; done += batch) {
    fc.assert(property, { numRuns: Math.min(batch, runs - done) });
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const ids = Object.values(COMMANDS).map((c) => c.id);
const lenient = new PduCodec({ strict: false });

function decodeSafely(buf: Buffer): void {
  for (const codec of [undefined, lenient]) {
    try {
      if (codec) codec.decode(buf);
      else decodePdu(buf);
    } catch (err) {
      if (!(err instanceof SmppDecodeError)) throw err;
    }
  }
}

/** PDU with a consistent header (exact length, known command_id) and a random body. */
const structuredPdu = fc
  .tuple(
    fc.constantFrom(...ids),
    fc.integer({ min: 0, max: 0xffffffff }),
    fc.integer({ min: 0, max: 0xffffffff }),
    fc.uint8Array({ maxLength: 300 }),
  )
  .map(([id, status, seq, body]) => {
    const buf = Buffer.alloc(16 + body.length);
    buf.writeUInt32BE(buf.length, 0);
    buf.writeUInt32BE(id, 4);
    buf.writeUInt32BE(status, 8);
    buf.writeUInt32BE(seq, 12);
    buf.set(body, 16);
    return buf;
  });

/** Valid PDU, tampered with: bytes changed, truncated or extended. */
const mutatedPdu = fc
  .tuple(
    fc.constantFrom(
      encodePdu({
        command: 'submit_sm',
        short_message: Buffer.from('hello'),
        receipted_message_id: 'x',
        sar_msg_ref_num: 1,
      }),
      encodePdu({
        command: 'deliver_sm',
        esm_class: 0x44,
        short_message: Buffer.from([5, 0, 3, 1, 2, 1, 65]),
      }),
      encodePdu({
        command: 'submit_multi',
        dest_address: [{ dest_flag: 1, dest_addr_ton: 1, dest_addr_npi: 1, destination_addr: '1' }],
      }),
      encodePdu({ command: 'bind_transceiver', system_id: 'a', password: 'b' }),
    ),
    fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 6 }),
    fc.integer({ min: -20, max: 20 }),
  )
  .map(([base, flips, delta]) => {
    const buf = Buffer.from(base);
    for (const [pos, val] of flips) {
      const i = 16 + (pos % Math.max(1, buf.length - 16));
      if (i < buf.length) buf[i] = val;
    }
    const len = Math.max(16, buf.length + delta);
    const out = Buffer.alloc(len);
    buf.copy(out, 0, 0, Math.min(buf.length, len));
    out.writeUInt32BE(len, 0);
    return out;
  });

describe('fuzz: the parser never throws unexpected exceptions', () => {
  it('random bytes through the framer and decoder', async () => {
    await assertInBatches(
      fc.property(fc.array(fc.uint8Array({ maxLength: 200 }), { maxLength: 8 }), (chunks) => {
        const framer = new Framer(4096);
        for (const c of chunks) {
          const { frames, error } = framer.push(Buffer.from(c));
          for (const f of frames) decodeSafely(f);
          if (error) expect(error).toBeInstanceOf(SmppDecodeError);
        }
      }),
      RUNS,
    );
  });

  it('structured PDUs with random bodies', async () => {
    await assertInBatches(
      fc.property(structuredPdu, (buf) => decodeSafely(buf)),
      RUNS,
    );
  });

  it('mutated valid PDUs (truncated, extended, flipped bytes)', async () => {
    await assertInBatches(
      fc.property(mutatedPdu, (buf) => decodeSafely(buf)),
      RUNS,
    );
  });

  it('incoherent lengths in the framer', async () => {
    await assertInBatches(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.uint8Array({ maxLength: 64 }), (len, rest) => {
        const head = Buffer.alloc(4);
        head.writeUInt32BE(len, 0);
        const { frames, error } = new Framer().push(Buffer.concat([head, rest]));
        for (const f of frames) decodeSafely(f);
        if (error) expect(error.fatal).toBe(true);
      }),
      RUNS,
    );
  });

  it('UDH, message content, DLR text and Proxy headers', async () => {
    await assertInBatches(
      fc.property(
        fc.uint8Array({ maxLength: 160 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (bytes, esm, dc) => {
          const b = Buffer.from(bytes);
          parseUdh(b);
          decodeMessageContent(
            { esm_class: esm, data_coding: dc, short_message: b },
            { packedGsm7: (esm & 1) === 1 },
          );
          parseDlr(b.toString('latin1'));
          parseProxyHeader(b);
          parseProxyHeader(Buffer.concat([Buffer.from('PROXY '), b]));
        },
      ),
      Math.floor(RUNS / 2),
    );
  });
});
