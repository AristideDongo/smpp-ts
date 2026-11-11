import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, cancellableSleep } from '../../src/client/reconnect.js';
import { SmppQueueFullError, SmppStateError, SmppTimeoutError } from '../../src/errors.js';
import { defaultStatusClassifier, statusName } from '../../src/protocol/status.js';
import { BindFailureTracker, safeCompare } from '../../src/server/auth.js';
import { TokenBucket } from '../../src/session/rate-limiter.js';
import { StateMachine, canSend, canSendInMode } from '../../src/session/state-machine.js';
import { RequestQueue, createPendingRequest } from '../../src/session/window.js';

describe('state machine (REL-01)', () => {
  it('follows the documented transitions and notifies', () => {
    const changes: string[] = [];
    const sm = new StateMachine('CLOSED', (a, b) => changes.push(`${a}>${b}`));
    sm.transition('OPEN');
    sm.transition('BOUND_TRX');
    sm.transition('UNBOUND');
    sm.transition('CLOSED');
    expect(changes).toEqual(['CLOSED>OPEN', 'OPEN>BOUND_TRX', 'BOUND_TRX>UNBOUND', 'UNBOUND>CLOSED']);
  });

  it('rejects invalid transitions', () => {
    const sm = new StateMachine('CLOSED', () => {});
    expect(() => sm.transition('BOUND_TX')).toThrow(SmppStateError);
  });

  it('only allows bind/enquire_link/generic_nack before bind (SEC-06)', () => {
    expect(canSend('esme', 'OPEN', 'bind_transmitter')).toBe(true);
    expect(canSend('esme', 'OPEN', 'enquire_link')).toBe(true);
    expect(canSend('esme', 'OPEN', 'submit_sm')).toBe(false);
    expect(canSend('esme', 'OPEN', 'unbind')).toBe(false);
    expect(canSend('smsc', 'OPEN', 'outbind')).toBe(true);
    expect(canSend('esme', 'CLOSED', 'enquire_link')).toBe(false);
    expect(canSend('esme', 'BOUND_TX', 'bind_transmitter')).toBe(false);
  });

  it('enforces bind mode rights (SEC-07)', () => {
    expect(canSend('esme', 'BOUND_TX', 'submit_sm')).toBe(true);
    expect(canSend('esme', 'BOUND_RX', 'submit_sm')).toBe(false);
    expect(canSend('smsc', 'BOUND_TX', 'deliver_sm')).toBe(false);
    expect(canSend('smsc', 'BOUND_RX', 'deliver_sm')).toBe(true);
    expect(canSend('smsc', 'BOUND_TRX', 'deliver_sm')).toBe(true);
    expect(canSend('esme', 'BOUND_RX', 'data_sm')).toBe(false);
    expect(canSend('smsc', 'BOUND_RX', 'data_sm')).toBe(true);
    expect(canSend('esme', 'BOUND_RX', 'deliver_sm_resp')).toBe(true);
    expect(canSendInMode('esme', 'receiver', 'submit_sm')).toBe(false);
    expect(canSendInMode('esme', 'transmitter', 'submit_sm')).toBe(true);
    expect(canSendInMode('esme', 'transmitter', 'bind_transmitter')).toBe(false);
  });
});

describe('pending requests and queue (BUG-01, REL-03)', () => {
  it('times out, rejects with SmppTimeoutError and releases the slot', async () => {
    const onTimeout = vi.fn();
    const { request, promise } = createPendingRequest({
      command: 'submit_sm',
      encoded: Buffer.alloc(16),
      timeoutMs: 20,
      onTimeout,
    });
    const queue = new RequestQueue(5);
    queue.push(request);
    await expect(promise).rejects.toBeInstanceOf(SmppTimeoutError);
    expect(queue.size).toBe(0);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('settles only once', async () => {
    const { request, promise } = createPendingRequest({
      command: 'submit_sm',
      encoded: Buffer.alloc(16),
      timeoutMs: 1000,
    });
    request.reject(new Error('first'));
    request.reject(new Error('second'));
    await expect(promise).rejects.toThrow('first');
  });

  it('rejects immediately when full', () => {
    const q = new RequestQueue(1);
    q.push(createPendingRequest({ command: 'submit_sm', encoded: Buffer.alloc(16), timeoutMs: 0 }).request);
    expect(() =>
      q.push(createPendingRequest({ command: 'submit_sm', encoded: Buffer.alloc(16), timeoutMs: 0 }).request),
    ).toThrow(SmppQueueFullError);
  });

  it('rejectAll rejects everything', async () => {
    const q = new RequestQueue();
    const a = createPendingRequest({ command: 'submit_sm', encoded: Buffer.alloc(16), timeoutMs: 0 });
    q.push(a.request);
    q.rejectAll(() => new Error('bye'));
    await expect(a.promise).rejects.toThrow('bye');
    expect(q.size).toBe(0);
  });
});

describe('TokenBucket (REL-04)', () => {
  it('limits rate and adapts on throttling', () => {
    let now = 0;
    const b = new TokenBucket({ perSecond: 10, burst: 2, cooldownMs: 1000 }, () => now);
    expect(b.take()).toBe(0);
    expect(b.take()).toBe(0);
    expect(b.take()).toBe(100);
    now += 100;
    expect(b.take()).toBe(0);
    b.penalize();
    expect(b.currentRate).toBe(5);
    b.penalize();
    expect(b.currentRate).toBe(2.5);
    now += 1000;
    expect(b.currentRate).toBe(5);
    now += 1000;
    expect(b.currentRate).toBe(10);
  });

  it('never goes below the minimum rate', () => {
    const b = new TokenBucket({ perSecond: 10, minFactor: 0.2 }, () => 0);
    for (let i = 0; i < 10; i++) b.penalize();
    expect(b.currentRate).toBe(2);
  });

  it('validates its options', () => {
    expect(() => new TokenBucket({ perSecond: 0 })).toThrow();
  });
});

describe('backoff (REL-05)', () => {
  it('grows exponentially, caps, and applies jitter', () => {
    const o = { initialDelay: 100, maxDelay: 1000, multiplier: 2, jitter: 0 };
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, o))).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(backoffDelay(1, { initialDelay: 100, jitter: 0.5 }, () => 0)).toBe(50);
    expect(backoffDelay(1, { initialDelay: 100, jitter: 0.5 }, () => 1)).toBe(100);
  });

  it('sleep is cancellable', async () => {
    const s = cancellableSleep(10_000);
    s.cancel();
    await s.promise;
  });
});

describe('status classification (REL-06)', () => {
  it('classifies statuses', () => {
    expect(defaultStatusClassifier(0)).toBe('ok');
    expect(defaultStatusClassifier(0x58)).toBe('temporary');
    expect(defaultStatusClassifier(0x14)).toBe('temporary');
    expect(defaultStatusClassifier(0x08)).toBe('temporary');
    expect(defaultStatusClassifier(0x0b)).toBe('permanent');
    expect(defaultStatusClassifier(0x04)).toBe('session');
    expect(defaultStatusClassifier(0x0d)).toBe('session');
    expect(statusName(0x58)).toBe('ESME_RTHROTTLED');
    expect(statusName(0x12345)).toBe('UNKNOWN_0x00012345');
  });
});

describe('server auth helpers (SEC-05, SEC-06)', () => {
  it('safeCompare', () => {
    expect(safeCompare('secret', 'secret')).toBe(true);
    expect(safeCompare('secret', 'secreT')).toBe(false);
    expect(safeCompare('secret', 'secret-longer')).toBe(false);
  });

  it('bans after repeated failures and expires', () => {
    let now = 0;
    const t = new BindFailureTracker({ maxAttempts: 3, windowMs: 1000, banMs: 5000 }, () => now);
    expect(t.recordFailure('1.2.3.4')).toBe(false);
    expect(t.recordFailure('1.2.3.4')).toBe(false);
    expect(t.recordFailure('1.2.3.4')).toBe(true);
    expect(t.isBanned('1.2.3.4')).toBe(true);
    expect(t.isBanned('5.6.7.8')).toBe(false);
    now += 5001;
    expect(t.isBanned('1.2.3.4')).toBe(false);
  });

  it('forgets failures outside the window', () => {
    let now = 0;
    const t = new BindFailureTracker({ maxAttempts: 2, windowMs: 100 }, () => now);
    t.recordFailure('ip');
    now += 200;
    expect(t.recordFailure('ip')).toBe(false);
    t.recordSuccess('ip');
    expect(t.isBanned('ip')).toBe(false);
  });
});
