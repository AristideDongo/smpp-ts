import { describe, expect, it } from 'vitest';
import { GaugeSampler } from '../../src/metrics.js';
import { TimeoutScheduler } from '../../src/session/timers.js';
import { sleep } from '../helpers/raw-smsc.js';

describe('TimeoutScheduler', () => {
  it('fires deadlines in order, whatever the order they were scheduled in', async () => {
    const s = new TimeoutScheduler();
    const fired: string[] = [];
    s.schedule(Date.now() + 40, () => fired.push('c'));
    s.schedule(Date.now() + 1, () => fired.push('a'));
    s.schedule(Date.now() + 20, () => fired.push('b'));
    expect(s.size).toBe(3);
    await sleep(90);
    expect(fired).toEqual(['a', 'b', 'c']);
    expect(s.size).toBe(0);
  });

  it('re-arms for an earlier deadline scheduled after a later one', async () => {
    const s = new TimeoutScheduler();
    const fired: number[] = [];
    s.schedule(Date.now() + 500, () => fired.push(500));
    s.schedule(Date.now() + 5, () => fired.push(5));
    await sleep(60);
    expect(fired).toEqual([5]); // the long one is still waiting, not dragged forward
  });

  it('does not fire a cancelled deadline', async () => {
    const s = new TimeoutScheduler();
    let fired = 0;
    const entry = s.schedule(Date.now() + 5, () => fired++);
    s.cancel(entry);
    s.cancel(entry); // idempotent
    expect(s.size).toBe(0);
    await sleep(40);
    expect(fired).toBe(0);
  });

  it('keeps firing after a callback throws', async () => {
    const s = new TimeoutScheduler();
    const fired: string[] = [];
    s.schedule(Date.now() + 1, () => {
      throw new Error('boom');
    });
    s.schedule(Date.now() + 2, () => fired.push('after'));
    await sleep(40);
    expect(fired).toEqual(['after']);
  });

  it('compacts the heap when cancelled deadlines pile up, keeping the live ones', async () => {
    const s = new TimeoutScheduler();
    const fired: number[] = [];
    const base = Date.now();
    const entries = Array.from({ length: 500 }, (_, i) => s.schedule(base + 20 + i, () => fired.push(i)));
    // Cancel every even one: compaction triggers along the way.
    for (let i = 0; i < entries.length; i += 2) s.cancel(entries[i]!);
    expect(s.size).toBe(250);
    await sleep(600);
    // The heap invariant held through compaction: the odd ones fired, in order, and only them.
    expect(fired).toEqual(entries.map((_, i) => i).filter((i) => i % 2 === 1));
    expect(s.size).toBe(0);
  });

  it('clear() drops everything without firing', async () => {
    const s = new TimeoutScheduler();
    let fired = 0;
    s.schedule(Date.now() + 5, () => fired++);
    s.clear();
    await sleep(30);
    expect(fired).toBe(0);
    expect(s.size).toBe(0);
  });

  it('fires 2 000 deadlines with a single timer', async () => {
    const s = new TimeoutScheduler();
    let fired = 0;
    const base = Date.now();
    for (let i = 0; i < 2000; i++) s.schedule(base + 5 + (i % 10), () => fired++);
    await sleep(120);
    expect(fired).toBe(2000);
    expect(s.size).toBe(0);
  });
});

describe('GaugeSampler', () => {
  it('samples a gauge and always lets a zero through', () => {
    let now = 0;
    const s = new GaugeSampler(50, () => now);
    expect(s.shouldEmit('queue.size', 5)).toBe(true);
    expect(s.shouldEmit('queue.size', 6)).toBe(false);
    // A zero is the state an application must not miss.
    expect(s.shouldEmit('queue.size', 0)).toBe(true);
    expect(s.shouldEmit('queue.size', 7)).toBe(false);
    now = 60;
    expect(s.shouldEmit('queue.size', 8)).toBe(true);
    // Each gauge has its own window.
    expect(s.shouldEmit('request.inflight', 3)).toBe(true);
  });

  it('interval 0 emits everything', () => {
    const s = new GaugeSampler(0, () => 0);
    for (let i = 1; i <= 5; i++) expect(s.shouldEmit('queue.size', i)).toBe(true);
  });
});
