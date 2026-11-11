import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeliveryReport, DeliveryTracker, type DlrStatus, type MessageStatus } from '../../src/index.js';

const dlr = (messageId: string, status: DlrStatus, rawMessageId = messageId): DeliveryReport => ({
  messageId,
  rawMessageId,
  status,
  rawStatus: status,
  source: '2250700000000',
  destination: 'MISSOU',
});

function setup(options: ConstructorParameters<typeof DeliveryTracker>[1] = {}) {
  const statuses: MessageStatus[] = [];
  const tracker = new DeliveryTracker((s) => statuses.push(s), options);
  return { tracker, statuses };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DeliveryTracker', () => {
  it('reports DELIVERED once every segment is delivered', () => {
    const { tracker, statuses } = setup();
    tracker.track(['a', 'b', 'c'], 'order-42');
    expect(tracker.handle(dlr('b', 'DELIVERED'))).toBe(true);
    expect(tracker.handle(dlr('a', 'DELIVERED'))).toBe(true);
    expect(statuses).toHaveLength(0);
    tracker.handle(dlr('c', 'DELIVERED'));
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ outcome: 'DELIVERED', parts: 3, reference: 'order-42' });
    expect(statuses[0]!.reports.map((r) => r?.messageId)).toEqual(['a', 'b', 'c']);
    expect(tracker.size).toBe(0);
  });

  it('reports FAILED when no segment is delivered and PARTIALLY_DELIVERED when some are', () => {
    const { tracker, statuses } = setup();
    tracker.track(['a', 'b']);
    tracker.handle(dlr('a', 'UNDELIVERABLE'));
    tracker.handle(dlr('b', 'EXPIRED'));
    tracker.track(['c', 'd']);
    tracker.handle(dlr('c', 'DELIVERED'));
    tracker.handle(dlr('d', 'REJECTED'));
    expect(statuses.map((s) => s.outcome)).toEqual(['FAILED', 'PARTIALLY_DELIVERED']);
  });

  it('ignores intermediate notifications', () => {
    const { tracker, statuses } = setup();
    tracker.track(['a']);
    expect(tracker.handle(dlr('a', 'ENROUTE'))).toBe(true);
    expect(tracker.handle(dlr('a', 'ACCEPTED'))).toBe(true);
    expect(statuses).toHaveLength(0);
    tracker.handle(dlr('a', 'DELIVERED'));
    expect(statuses[0]?.outcome).toBe('DELIVERED');
  });

  it('counts a duplicated final report only once', () => {
    const { tracker, statuses } = setup();
    tracker.track(['a', 'b']);
    tracker.handle(dlr('a', 'DELIVERED'));
    tracker.handle(dlr('a', 'DELIVERED'));
    expect(statuses).toHaveLength(0);
  });

  it('matches on the raw id when the normalized one differs', () => {
    const { tracker, statuses } = setup();
    tracker.track(['ff']);
    tracker.handle(dlr('255', 'DELIVERED', 'ff'));
    expect(statuses[0]?.outcome).toBe('DELIVERED');
  });

  it('keeps reports that arrive before track() (orphans)', () => {
    const { tracker, statuses } = setup();
    expect(tracker.handle(dlr('a', 'DELIVERED'))).toBe(false);
    expect(tracker.handle(dlr('z', 'ENROUTE'))).toBe(false);
    tracker.track(['a', 'b']);
    expect(statuses).toHaveLength(0);
    tracker.handle(dlr('b', 'DELIVERED'));
    expect(statuses[0]?.outcome).toBe('DELIVERED');
  });

  it('closes a single-part message straight from its orphan', () => {
    const { tracker, statuses } = setup();
    tracker.handle(dlr('a', 'UNDELIVERABLE'));
    tracker.track(['a']);
    expect(statuses[0]?.outcome).toBe('FAILED');
  });

  it('drops orphans after orphanTtl and caps their number', () => {
    vi.useFakeTimers();
    const { tracker, statuses } = setup({ orphanTtl: 1000, maxOrphans: 2 });
    tracker.handle(dlr('a', 'DELIVERED'));
    vi.advanceTimersByTime(1001);
    tracker.track(['a']);
    expect(statuses).toHaveLength(0);

    tracker.handle(dlr('x', 'DELIVERED'));
    tracker.handle(dlr('y', 'DELIVERED'));
    tracker.handle(dlr('y', 'DELIVERED')); // remplace sans évincer
    tracker.handle(dlr('z', 'DELIVERED')); // évince x
    tracker.track(['x']);
    tracker.track(['z']);
    expect(statuses.map((s) => s.messageIds[0])).toEqual(['z']);
  });

  it('reports TIMEOUT when reports do not arrive within ttl', () => {
    vi.useFakeTimers();
    const { tracker, statuses } = setup({ ttl: 5000 });
    tracker.track(['a', 'b']);
    tracker.handle(dlr('a', 'DELIVERED'));
    vi.advanceTimersByTime(5001);
    expect(statuses[0]).toMatchObject({ outcome: 'TIMEOUT', parts: 2 });
    expect(statuses[0]!.reports[1]).toBeUndefined();
    // un accusé tardif n'est plus rattaché
    expect(tracker.handle(dlr('b', 'DELIVERED'))).toBe(false);
  });

  it('evicts the oldest message as TIMEOUT when maxTracked is reached', () => {
    const { tracker, statuses } = setup({ maxTracked: 2 });
    tracker.track(['a']);
    tracker.track(['b']);
    tracker.track(['c']);
    expect(tracker.size).toBe(2);
    expect(statuses).toEqual([expect.objectContaining({ outcome: 'TIMEOUT', messageIds: ['a'] })]);
  });

  it('clear() drops everything silently', () => {
    const { tracker, statuses } = setup();
    tracker.track(['a']);
    tracker.handle(dlr('o', 'DELIVERED'));
    tracker.clear();
    tracker.track(['o']);
    expect(statuses).toHaveLength(0);
    expect(tracker.size).toBe(1);
  });

  it('ignores an empty id list', () => {
    const { tracker } = setup();
    tracker.track([]);
    expect(tracker.size).toBe(0);
  });
});
