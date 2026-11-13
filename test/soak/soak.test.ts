// Soak test: a client sends for a long time through disconnections, and memory must stay flat.
// Opt-in (several minutes): `npm run soak`, or SOAK=1 SOAK_MESSAGES=50000 vitest run test/soak.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { SmppClient, SmppConnectionClosedError, SmppTimeoutError } from '../../src/index.js';
import { createTestSmsc } from '../../src/testing/index.js';
import { until } from '../helpers/raw-smsc.js';

const MESSAGES = Number(process.env.SOAK_MESSAGES ?? 200_000);
const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 20);
/** Heap growth tolerated between the end of the warm-up and the end of the run. */
const MAX_GROWTH = 24 * 1024 * 1024;

function gc(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

describe.skipIf(!process.env.SOAK)('soak', () => {
  it(
    'keeps memory flat across messages, receipts and reconnections',
    async () => {
      const smsc = await createTestSmsc({ receipts: 'DELIVERED' });
      cleanups.push(() => smsc.close());
      const client = new SmppClient({
        url: smsc.url,
        bind: { mode: 'transceiver', system_id: 'soak', password: 'x' },
        window: 50,
        reconnect: { initialDelay: 10, maxDelay: 50 },
        trackDeliveries: true,
        enquireLinkInterval: 1_000,
      });
      cleanups.push(() => client.close());
      let receipts = 0;
      let errors = 0;
      client.on('deliveryReport', () => receipts++);
      client.on('error', () => errors++);
      await client.connect();

      const perRound = Math.floor(MESSAGES / ROUNDS);
      const samples: number[] = [];
      let accepted = 0;
      let lost = 0;
      for (let round = 0; round < ROUNDS; round++) {
        // Batches of 1,000 in flight: like an application fed by a job queue, and within the
        // test SMSC's own send queue for the receipts.
        let sends: Promise<void>[] = [];
        for (let i = 0; i < perRound; i++) {
          if (sends.length === 1_000) {
            await Promise.all(sends);
            sends = [];
          }
          sends.push(
            client
              .sendText({
                to: `2250700${String(i).padStart(6, '0')}`,
                from: 'SOAK',
                text: `m${i}`,
                registeredDelivery: true,
              })
              .then(() => {
                accepted++;
              })
              .catch((err: unknown) => {
                // Requests in flight when the SMSC disconnects are rejected, never silently lost (BUG-02).
                if (err instanceof SmppConnectionClosedError || err instanceof SmppTimeoutError) lost++;
                else throw err;
              }),
          );
        }
        await Promise.all(sends);
        // Every accepted message of the round gets its receipt: the tracker must let go of all of them.
        await until(() => receipts >= accepted, 60_000, 50);
        await until(() => client.trackedMessages === 0, 10_000, 50);
        // Then the SMSC drops the connection (half of the rounds): in-flight requests are rejected
        // (BUG-02), the client reconnects and re-binds by itself, the next round goes on.
        if (round % 2 === 0) {
          const sent = client
            .sendText({ to: '2250700000000', from: 'SOAK', text: 'cut' })
            .catch((err: unknown) => {
              if (err instanceof SmppConnectionClosedError || err instanceof SmppTimeoutError) lost++;
              else throw err;
            });
          smsc.disconnectAll();
          await sent;
          await until(() => client.isBound, 10_000);
        }
        // The test SMSC records every PDU for assertions: not what is measured here.
        smsc.reset();
        gc();
        samples.push(process.memoryUsage().heapUsed);
      }
      gc();
      const end = process.memoryUsage().heapUsed;

      const warm = samples[Math.floor(ROUNDS / 4)]!;
      console.log(
        `soak: ${accepted} accepted, ${lost} rejected on disconnect, ${receipts} receipts, ${errors} errors, ` +
          `heap ${(warm / 1e6).toFixed(1)} MB → ${(end / 1e6).toFixed(1)} MB`,
      );
      expect(end - warm).toBeLessThan(MAX_GROWTH);
      expect(client.inflight).toBe(0);
      expect(client.queueSize).toBe(0);
      expect(client.pendingInboundCount).toBe(0);
      expect(client.trackedMessages).toBe(0);
      expect(receipts).toBe(accepted);
      expect(smsc.sessions).toHaveLength(1);
    },
    30 * 60_000,
  );
});
