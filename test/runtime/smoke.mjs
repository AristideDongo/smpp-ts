// Test de fumée multi-runtime (Node, Bun, Deno) sur le paquet compilé (`npm run build`).
// Usage : node test/runtime/smoke.mjs | bun test/runtime/smoke.mjs | deno run -A test/runtime/smoke.mjs
import assert from 'node:assert/strict';
import { SmppClient, SmppServer, countSegments, parseDlr, safeCompare } from '../../dist/index.js';

const runtime =
  typeof globalThis.Bun !== 'undefined'
    ? `bun ${globalThis.Bun.version}`
    : typeof globalThis.Deno !== 'undefined'
      ? `deno ${globalThis.Deno.version.deno}`
      : `node ${process.versions.node}`;

const timeout = setTimeout(() => {
  console.error(`[${runtime}] smoke test timed out`);
  process.exit(1);
}, 15_000);

let counter = 0;
const server = new SmppServer({
  authenticate: ({ system_id, password }) => system_id === 'smoke' && safeCompare(password, 'secret'),
  handlers: { submit_sm: () => ({ message_id: `M${++counter}` }) },
});
const { port } = await server.listen(0, '127.0.0.1');

const client = new SmppClient({
  url: `smpp://127.0.0.1:${port}`,
  bind: { mode: 'transceiver', system_id: 'smoke', password: 'secret' },
  reconnect: false,
  trackDeliveries: true,
});

try {
  // Encodages (Buffer, UTF-16) et utilitaires purs
  assert.equal(countSegments('Votre code est 123456 🎉').encoding, 'ucs2');
  assert.equal(parseDlr('id:1 sub:001 dlvrd:001 stat:DELIVRD err:000')?.stat, 'DELIVRD');

  // Transport TCP, framing, machine à états
  await client.connect();
  assert.equal(client.state, 'BOUND_TRX');

  const result = await client.sendText({
    to: '+225 07 00 00 00 00',
    from: 'SMOKE',
    text: `${'é'.repeat(150)} 🎉`,
    registeredDelivery: true,
  });
  assert.equal(result.parts, 3);

  // Accusés : serveur → client, regroupés par le suivi multi-segments
  const status = new Promise((resolve) => client.once('messageStatus', resolve));
  const session = [...server.sessions][0];
  for (const messageId of result.messageIds) {
    await session.deliverReceipt({
      messageId,
      status: 'DELIVERED',
      source: '2250700000000',
      destination: 'SMOKE',
    });
  }
  assert.equal((await status).outcome, 'DELIVERED');

  await client.close({ drain: true });
  assert.equal(client.state, 'CLOSED');
  console.log(`[${runtime}] smoke test passed`);
} catch (err) {
  console.error(`[${runtime}] smoke test failed`, err);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await server.close();
}
