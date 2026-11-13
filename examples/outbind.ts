/**
 * Outbind: the SMSC connects to you, sends `outbind` with its credentials, and the library answers
 * with `bind_receiver`. Each accepted connection is an ordinary bound client.
 *
 *   OUTBIND_SYSTEM_ID=smsc OUTBIND_PASSWORD=pw SMPP_USER=xxx SMPP_PASSWORD=yyy npx tsx examples/outbind.ts
 */
// In your project: import { OutbindServer, safeCompare } from 'smpp-ts';
import { OutbindServer, safeCompare } from '../src/index.js';

const outbind = new OutbindServer({
  // Credentials the SMSC presents in its outbind (constant-time comparison).
  authenticate: ({ system_id, password }) =>
    system_id === process.env.OUTBIND_SYSTEM_ID && safeCompare(password, process.env.OUTBIND_PASSWORD ?? ''),
  // Options of the client bound on each accepted connection.
  client: {
    bind: { system_id: process.env.SMPP_USER ?? 'acme', password: process.env.SMPP_PASSWORD ?? 'secret' },
    logger: console,
  },
  outbindTimeout: 10_000,
  maxSessions: 2,
});

outbind.on('session', (client, info) => {
  console.log(`bound session from ${info.remoteAddress} (${info.system_id})`);
  client.on('message', (msg) => console.log(`${msg.from} → ${msg.to}: ${msg.text}`));
  client.on('deliveryReport', (dlr) => console.log(`receipt ${dlr.messageId}: ${dlr.status}`));
  client.on('close', () => console.log('session closed by the SMSC'));
});
outbind.on('rejected', (reason, remoteAddress) => console.warn(`rejected ${remoteAddress}: ${reason}`));

const { port } = await outbind.listen(2775);
console.log(`waiting for the SMSC on port ${port}`);

process.on('SIGINT', async () => {
  await outbind.close({ drain: true });
  process.exit(0);
});
