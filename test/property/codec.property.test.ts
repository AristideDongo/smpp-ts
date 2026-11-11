import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Framer } from '../../src/codec/framer.js';
import { type PduInput, decodePdu, encodePdu } from '../../src/codec/pdu.js';
import { GSM7_BASIC_TABLE, decodeGsm7, encodeGsm7 } from '../../src/encoding/gsm7.js';
import { decodeUcs2, encodeUcs2 } from '../../src/encoding/ucs2.js';
import { COMMANDS, type CommandName, type FieldDefinition } from '../../src/protocol/commands.js';
import { Reassembler, buildParts, decodeMessageContent } from '../../src/utils/multipart.js';

const RUNS = Number(process.env.PROPERTY_RUNS ?? 300);

const latin1String = (max: number) =>
  fc.string({
    unit: fc.integer({ min: 1, max: 0xff }).map((c) => String.fromCharCode(c)),
    maxLength: max - 1,
  });

function fieldArb(f: FieldDefinition): fc.Arbitrary<unknown> | undefined {
  switch (f.type) {
    case 'uint8':
      return fc.integer({ min: 0, max: 0xff });
    case 'uint16':
      return fc.integer({ min: 0, max: 0xffff });
    case 'uint32':
      return fc.integer({ min: 0, max: 0xffffffff });
    case 'cstring':
      return latin1String(f.max ?? 256);
    case 'short_message':
      return fc.uint8Array({ maxLength: 255 }).map((a) => Buffer.from(a));
    case 'dest_address_list':
      return fc.array(
        fc.oneof(
          fc.record({
            dest_flag: fc.constant(1 as const),
            dest_addr_ton: fc.integer({ min: 0, max: 255 }),
            dest_addr_npi: fc.integer({ min: 0, max: 255 }),
            destination_addr: latin1String(21),
          }),
          fc.record({ dest_flag: fc.constant(2 as const), dl_name: latin1String(21) }),
        ),
        { minLength: 1, maxLength: 5 },
      );
    case 'unsuccess_sme_list':
      return fc.array(
        fc.record({
          dest_addr_ton: fc.integer({ min: 0, max: 255 }),
          dest_addr_npi: fc.integer({ min: 0, max: 255 }),
          destination_addr: latin1String(21),
          error_status_code: fc.integer({ min: 0, max: 0xffffffff }),
        }),
        { maxLength: 5 },
      );
    default:
      return undefined;
  }
}

const tlvArb = fc.record(
  {
    user_message_reference: fc.integer({ min: 0, max: 0xffff }),
    receipted_message_id: latin1String(65),
    message_state: fc.integer({ min: 0, max: 9 }),
    sar_msg_ref_num: fc.integer({ min: 0, max: 0xffff }),
    qos_time_to_live: fc.integer({ min: 0, max: 0xffffffff }),
    network_error_code: fc.record({
      network_type: fc.integer({ min: 0, max: 255 }),
      error_code: fc.integer({ min: 0, max: 0xffff }),
    }),
  },
  { requiredKeys: [] },
);

function pduArb(command: CommandName): fc.Arbitrary<PduInput> {
  const def = COMMANDS[command] as { params: readonly FieldDefinition[] };
  const fields: Record<string, fc.Arbitrary<unknown>> = {};
  for (const f of def.params) {
    const a = fieldArb(f);
    if (a) fields[f.name] = a;
  }
  return fc
    .tuple(
      fc.record(fields),
      tlvArb,
      fc.integer({ min: 0, max: 0x7fffffff }),
      fc.integer({ min: 0, max: 0xffffffff }),
    )
    .map(
      ([params, tlvs, seq, status]) =>
        ({ command, sequence_number: seq, command_status: status, ...params, ...tlvs }) as PduInput,
    );
}

describe('property: decode(encode(pdu)) ≡ pdu', () => {
  for (const command of Object.keys(COMMANDS) as CommandName[]) {
    it(command, () => {
      fc.assert(
        fc.property(pduArb(command), (input) => {
          const buf = encodePdu(input);
          const decoded = decodePdu(buf) as unknown as Record<string, unknown>;
          for (const [k, v] of Object.entries(input)) {
            if (k === 'sm_length') continue;
            expect(decoded[k], k).toEqual(v);
          }
          // Re-encoding the decoded PDU gives exactly the same bytes.
          expect(encodePdu(decoded as unknown as PduInput).equals(buf)).toBe(true);
        }),
        { numRuns: Math.max(20, Math.floor(RUNS / 5)) },
      );
    });
  }
});

describe('property: framing is independent of fragmentation', () => {
  it('any split of a PDU stream yields the same frames', () => {
    fc.assert(
      fc.property(
        fc.array(pduArb('submit_sm'), { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 50 }),
        (pdus, sizes) => {
          const encoded = pdus.map((p) => encodePdu(p));
          const stream = Buffer.concat(encoded);
          const framer = new Framer();
          const frames: Buffer[] = [];
          let off = 0;
          let i = 0;
          while (off < stream.length) {
            const n = sizes[i++ % sizes.length]!;
            frames.push(...framer.push(stream.subarray(off, off + n)).frames);
            off += n;
          }
          expect(frames.map((f) => f.toString('hex'))).toEqual(encoded.map((e) => e.toString('hex')));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

const gsmChar = fc.constantFrom(
  ...[...GSM7_BASIC_TABLE].filter((c) => c !== '\u001b'),
  '€',
  '[',
  ']',
  '{',
  '}',
  '\\',
  '^',
  '~',
  '|',
);
const anyText = fc.string({ unit: 'grapheme', maxLength: 600 });
const gsmText = fc.array(gsmChar, { maxLength: 600 }).map((a) => a.join(''));

describe('property: encodings', () => {
  it('GSM7 round-trips', () => {
    fc.assert(
      fc.property(gsmText, (t) => {
        expect(decodeGsm7(encodeGsm7(t))).toBe(t);
      }),
      { numRuns: RUNS },
    );
  });
  it('UCS2 round-trips (well-formed strings)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (t) => {
        expect(decodeUcs2(encodeUcs2(t))).toBe(t);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('property: split then reassemble = original text', () => {
  for (const strategy of ['udh8', 'udh16', 'sar'] as const) {
    it(strategy, () => {
      fc.assert(
        fc.property(fc.oneof(gsmText, anyText), fc.integer({ min: 0, max: 0xffff }), (text, reference) => {
          const built = buildParts(text, { reference, strategy });
          for (const p of built.parts) expect(p.short_message!.length).toBeLessThanOrEqual(140);
          const r = new Reassembler();
          let result: string | undefined;
          // Reverse order to exercise reassembly.
          for (const part of [...built.parts].reverse()) {
            const content = decodeMessageContent({ ...part, short_message: part.short_message! });
            if (!content.concat) {
              result = content.text;
              continue;
            }
            const done = r.add({
              source: 'a',
              destination: 'b',
              concat: content.concat,
              body: content.body,
              dataCoding: part.data_coding,
              meta: null,
            });
            if (done) result = done.text;
          }
          expect(result).toBe(text);
        }),
        { numRuns: RUNS },
      );
    });
  }
});
