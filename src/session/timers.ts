/**
 * One timer for many deadlines.
 *
 * Every request used to carry its own `setTimeout`: at 90,000 requests per second that is 90,000
 * timers armed and cleared every second, each one an allocation in the event loop's timer list. The
 * tracker had the same shape, with up to 100,000 timers alive at once. A min-heap of deadlines
 * behind a single `setTimeout` costs one allocation per entry and nothing in libuv.
 *
 * Cancellation is lazy: the entry stays in the heap with its callback cleared, and the heap is
 * compacted once the dead entries outnumber the live ones. The timer is `unref`'d, so a pending
 * deadline never keeps the process alive.
 */

/** A scheduled deadline. Opaque: pass it back to `cancel`. */
export interface ScheduledTimeout {
  deadline: number;
  /** Cleared on cancellation and after firing. */
  fire: (() => void) | undefined;
}

/** Deadlines within this many milliseconds of each other fire in the same sweep. */
const TOLERANCE = 1;

export class TimeoutScheduler {
  private heap: ScheduledTimeout[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armedFor = Number.POSITIVE_INFINITY;
  private dead = 0;
  /**
   * Timer functions the pending timer was armed with. A mocked clock (fake timers in a test suite)
   * replaces them globally: comparing them tells us the armed timer will never fire, and the sweep
   * has to be armed again with the implementation now in place.
   */
  private armedWith: typeof setTimeout | undefined;
  private clearWith: typeof clearTimeout | undefined;

  /**
   * `now` is called through, not captured: `Date.now` bound at construction would ignore a clock
   * mocked afterwards (fake timers in tests, `vi.setSystemTime`).
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Live deadlines (cancelled entries not yet compacted excluded). */
  get size(): number {
    return this.heap.length - this.dead;
  }

  /** Calls `fire` once, at `deadline` (epoch ms) or just after. */
  schedule(deadline: number, fire: () => void): ScheduledTimeout {
    const entry: ScheduledTimeout = { deadline, fire };
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
    this.ensureArmed();
    return entry;
  }

  /** Cancels a deadline. Cheap and safe to call twice. */
  cancel(entry: ScheduledTimeout | undefined): void {
    if (!entry?.fire) return;
    entry.fire = undefined;
    this.dead++;
    // Compaction pays for itself once the dead outnumber the live.
    if (this.dead > 64 && this.dead * 2 > this.heap.length) this.compact();
  }

  /** Drops every deadline without firing it (tests, shutdown). */
  clear(): void {
    this.heap = [];
    this.dead = 0;
    this.disarm();
  }

  /** Arms the sweep for the earliest deadline, if it is not armed for it already. */
  private ensureArmed(): void {
    const top = this.heap[0];
    if (!top) {
      this.disarm();
      return;
    }
    if (this.timer === undefined || top.deadline < this.armedFor || this.armedWith !== setTimeout) {
      this.arm(top.deadline);
    }
  }

  private arm(deadline: number): void {
    this.disarm();
    this.armedFor = deadline;
    const delay = Math.max(0, deadline - this.now());
    this.armedWith = setTimeout;
    this.clearWith = clearTimeout;
    this.timer = this.armedWith(() => this.sweep(), delay);
    this.timer.unref?.();
  }

  private disarm(): void {
    // Cleared with the implementation that armed it, which may no longer be the global one.
    if (this.timer) (this.clearWith ?? clearTimeout)(this.timer);
    this.timer = undefined;
    this.armedWith = undefined;
    this.clearWith = undefined;
    this.armedFor = Number.POSITIVE_INFINITY;
  }

  /** Fires every deadline that has come, then re-arms for the next one. */
  private sweep(): void {
    this.timer = undefined;
    this.armedWith = undefined;
    this.clearWith = undefined;
    this.armedFor = Number.POSITIVE_INFINITY;
    const limit = this.now() + TOLERANCE;
    while (this.heap.length > 0) {
      const top = this.heap[0]!;
      if (top.deadline > limit) break;
      this.pop();
      const fire = top.fire;
      if (fire === undefined) {
        this.dead--;
        continue;
      }
      top.fire = undefined;
      try {
        fire();
      } catch {
        // A callback must never break the sweep: the other deadlines still fire.
      }
    }
    this.ensureArmed();
  }

  private compact(): void {
    this.heap = this.heap.filter((e) => e.fire !== undefined);
    this.dead = 0;
    // Rebuild in place: Floyd's heapify is O(n), sorting would be O(n log n).
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
    this.ensureArmed();
  }

  private pop(): void {
    const last = this.heap.pop()!;
    if (this.heap.length === 0) return;
    this.heap[0] = last;
    this.siftDown(0);
  }

  private siftUp(start: number): void {
    const heap = this.heap;
    let i = start;
    const entry = heap[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.deadline <= entry.deadline) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = entry;
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const n = heap.length;
    let i = start;
    const entry = heap[i]!;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= n) break;
      const right = left + 1;
      const child = right < n && heap[right]!.deadline < heap[left]!.deadline ? right : left;
      if (heap[child]!.deadline >= entry.deadline) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = entry;
  }
}

/** Scheduler shared by every session and tracker of the process. */
export const defaultTimeoutScheduler: TimeoutScheduler = new TimeoutScheduler();
