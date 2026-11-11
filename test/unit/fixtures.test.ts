import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DeliveryReport,
  type InboundMessage,
  InboundProcessor,
  type MessageIdFormat,
  decodePdu,
  encodings,
  silentLogger,
} from '../../src/index.js';

interface Fixture {
  name: string;
  origin: string;
  messageIdFormat?: MessageIdFormat;
  pdus: string[];
  expect: {
    dlr?: Record<string, unknown>;
    message?: Partial<InboundMessage>;
  };
}

const dir = join(import.meta.dirname, '..', 'fixtures');
const files = ['deliver_sm.json', ...safeList(join(dir, 'captures')).map((f) => join('captures', f))];
const fixtures: Fixture[] = files.flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture[]);

function safeList(path: string): string[] {
  try {
    return readdirSync(path).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/** Runs the PDUs through the same path as a client: decode, then receipt / message processing. */
function replay(f: Fixture) {
  const dlrs: DeliveryReport[] = [];
  const messages: InboundMessage[] = [];
  const processor = new InboundProcessor(
    { registry: encodings, logger: silentLogger, messageIdFormat: f.messageIdFormat ?? 'as-is' },
    {
      deliveryReport: (dlr) => dlrs.push(dlr),
      message: (m) => messages.push(m),
      partialMessage: () => {},
    },
  );
  for (const hex of f.pdus) {
    const pdu = decodePdu(Buffer.from(hex, 'hex'));
    expect(pdu.command).toBe('deliver_sm');
    processor.handle(pdu as never);
  }
  processor.clear();
  return { dlrs, messages };
}

describe('operator formats (test/fixtures)', () => {
  it('has fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  for (const f of fixtures) {
    it(`${f.name}: ${f.origin}`, () => {
      const { dlrs, messages } = replay(f);
      if (f.expect.dlr) {
        expect(messages).toHaveLength(0);
        expect(dlrs).toHaveLength(1);
        const dlr = dlrs[0]!;
        for (const [key, value] of Object.entries(f.expect.dlr)) {
          const actual = (dlr as unknown as Record<string, unknown>)[key];
          if (actual instanceof Date) expect(actual.toISOString(), key).toBe(value);
          else expect(actual, key).toEqual(value);
        }
      }
      if (f.expect.message) {
        expect(dlrs).toHaveLength(0);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject(f.expect.message);
      }
    });
  }
});
