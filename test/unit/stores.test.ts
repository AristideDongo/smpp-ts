import { describe, expect, it } from 'vitest';
import {
  type DeliveryReport,
  DeliveryTracker,
  type DeliveryTrackerStore,
  type DlrStatus,
  type MessageStatus,
  type TrackedMessageRecord,
} from '../../src/index.js';

const dlr = (messageId: string, status: DlrStatus, extra: Partial<DeliveryReport> = {}): DeliveryReport => ({
  messageId,
  rawMessageId: messageId,
  status,
  rawStatus: status,
  source: '2250700000000',
  destination: 'MISSOU',
  ...extra,
});

/** In-memory store that goes through JSON, like Redis or a database would. */
function jsonStore() {
  const data = new Map<string, string>();
  const store: DeliveryTrackerStore = {
    save: (r) => {
      data.set(r.key, JSON.stringify(r));
    },
    delete: (key) => {
      data.delete(key);
    },
    load: () => [...data.values()].map((v) => JSON.parse(v) as TrackedMessageRecord),
  };
  return { store, data };
}

function tracker(
  store: DeliveryTrackerStore,
  options: { ttl?: number; onStoreError?: (e: unknown) => void } = {},
) {
  const statuses: MessageStatus[] = [];
  const t = new DeliveryTracker((s) => statuses.push(s), { store, ...options });
  return { tracker: t, statuses };
}

describe('DeliveryTracker with a store', () => {
  it('writes every change through: created, updated on each final receipt, deleted on outcome', () => {
    const { store, data } = jsonStore();
    const { tracker: t } = tracker(store);
    t.track(['a', 'b'], 'order-1');
    expect(JSON.parse(data.get('a')!)).toMatchObject({
      messageIds: ['a', 'b'],
      reports: [null, null],
      reference: 'order-1',
    });
    t.handle(dlr('b', 'DELIVERED'));
    expect(JSON.parse(data.get('a')!).reports[1]).toMatchObject({ status: 'DELIVERED' });
    t.handle(dlr('a', 'DELIVERED'));
    expect(data.size).toBe(0);
  });

  it('a new tracker resumes from the store after a restart', async () => {
    const { store } = jsonStore();
    const done = new Date('2026-11-11T10:31:00Z');
    const before = tracker(store);
    before.tracker.track(['a', 'b', 'c'], 'order-2');
    before.tracker.handle(dlr('a', 'DELIVERED', { doneDate: done }));
    const submittedAt = ((await store.load()) as TrackedMessageRecord[])[0]!.submittedAt;

    // "Restart": a new tracker, same store.
    const after = tracker(store);
    expect(await after.tracker.restore()).toBe(1);
    expect(await after.tracker.restore()).toBe(1); // idempotent
    expect(after.tracker.size).toBe(1);
    after.tracker.handle(dlr('b', 'DELIVERED'));
    after.tracker.handle(dlr('c', 'UNDELIVERABLE'));
    expect(after.statuses).toHaveLength(1);
    const status = after.statuses[0]!;
    expect(status).toMatchObject({ outcome: 'PARTIALLY_DELIVERED', reference: 'order-2', parts: 3 });
    expect(status.submittedAt.getTime()).toBe(submittedAt);
    // Dates went through JSON and came back as Date.
    expect(status.reports[0]!.doneDate).toBeInstanceOf(Date);
    expect(status.reports[0]!.doneDate!.getTime()).toBe(done.getTime());
  });

  it('closes as TIMEOUT a stored message whose ttl has passed', async () => {
    const { store, data } = jsonStore();
    const record: TrackedMessageRecord = {
      key: 'x',
      messageIds: ['x'],
      reports: [null],
      submittedAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1,
    };
    data.set('x', JSON.stringify(record));
    const { tracker: t, statuses } = tracker(store);
    await t.restore();
    await new Promise((r) => setTimeout(r, 10));
    expect(statuses).toMatchObject([{ outcome: 'TIMEOUT', messageIds: ['x'] }]);
    expect(data.size).toBe(0);
  });

  it('keeps tracking in memory when the store fails, and reports the errors', async () => {
    const errors: unknown[] = [];
    const failing: DeliveryTrackerStore = {
      save: () => Promise.reject(new Error('redis down')),
      delete: () => {
        throw new Error('redis down');
      },
      load: () => Promise.reject(new Error('redis down')),
    };
    const { tracker: t, statuses } = tracker(failing, { onStoreError: (e) => errors.push(e) });
    expect(await t.restore()).toBe(0);
    t.track(['a']);
    t.handle(dlr('a', 'DELIVERED'));
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses).toMatchObject([{ outcome: 'DELIVERED' }]);
    expect(errors).toHaveLength(3);
  });
});
