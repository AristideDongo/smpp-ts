import { describe, expect, it } from 'vitest';
import { Framer } from '../../src/codec/framer.js';
import { encodePdu } from '../../src/codec/pdu.js';

const pdus = [
  encodePdu({ command: 'enquire_link', sequence_number: 1 }),
  encodePdu({ command: 'submit_sm', sequence_number: 2, short_message: Buffer.from('hello world') }),
  encodePdu({ command: 'bind_transceiver', sequence_number: 3, system_id: 'id', password: 'pw' }),
];
const stream = Buffer.concat(pdus);

describe('Framer (REL-08)', () => {
  it('extracts several PDUs from one chunk', () => {
    const { frames, error } = new Framer().push(stream);
    expect(error).toBeUndefined();
    expect(frames.map((f) => f.toString('hex'))).toEqual(pdus.map((p) => p.toString('hex')));
  });

  it('gives the same result when fed byte by byte', () => {
    const f = new Framer();
    const frames: Buffer[] = [];
    for (const byte of stream) frames.push(...f.push(Buffer.from([byte])).frames);
    expect(Buffer.concat(frames).equals(stream)).toBe(true);
    expect(frames).toHaveLength(3);
    expect(f.pendingBytes).toBe(0);
  });

  it('handles arbitrary split points', () => {
    for (let cut = 1; cut < stream.length; cut++) {
      const f = new Framer();
      const a = f.push(stream.subarray(0, cut)).frames;
      const b = f.push(stream.subarray(cut)).frames;
      expect([...a, ...b]).toHaveLength(3);
    }
  });

  it('reports a fatal error for command_length < 16', () => {
    const bad = Buffer.from([0, 0, 0, 8, 0, 0, 0, 0]);
    const res = new Framer().push(bad);
    expect(res.error?.fatal).toBe(true);
  });

  it('reports a fatal error for command_length > maxPduLength', () => {
    const f = new Framer(1000);
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(5000, 0);
    expect(f.push(bad).error?.message).toMatch(/exceeds maxPduLength/);
    // Once out of sync, the framer stays in error.
    expect(f.push(pdus[0]!).error).toBeDefined();
    f.reset();
    expect(f.push(pdus[0]!).frames).toHaveLength(1);
  });

  it('frames are copies, not views on the network buffer', () => {
    const chunk = Buffer.from(stream);
    const { frames } = new Framer().push(chunk);
    chunk.fill(0);
    expect(frames[0]!.readUInt32BE(0)).toBe(16);
  });
});
