/**
 * Client : connexion TLS, envoi d'un SMS (découpé si nécessaire), accusés de réception, arrêt gracieux.
 *
 *   SMPP_URL=ssmpp://smsc.example.com:3550 SMPP_USER=xxx SMPP_PASSWORD=yyy npx tsx examples/client.ts
 */
import { SmppClient, SmppConnectionClosedError, SmppStatusError, SmppTimeoutError } from '../src/index.js';

const client = new SmppClient({
  url: process.env.SMPP_URL ?? 'smpp://127.0.0.1:2775',
  // SMSC à certificat auto-signé : fournir son autorité plutôt que désactiver la vérification.
  // tls: { ca: readFileSync('smsc-ca.pem') },
  bind: {
    mode: 'transceiver',
    system_id: process.env.SMPP_USER ?? 'acme',
    password: process.env.SMPP_PASSWORD ?? 'secret',
  },
  window: 10,
  rateLimit: { perSecond: 50 },
  reconnect: { initialDelay: 1_000, maxDelay: 30_000 },
  requestTimeout: 10_000,
  logger: console,
  redactContent: true,
});

client.on('stateChange', (from, to) => console.log(`state: ${from} -> ${to}`));
client.on('reconnecting', (attempt, delay) => console.log(`reconnecting #${attempt} in ${delay} ms`));
client.on('deliveryReport', (dlr) => console.log('DLR', dlr.messageId, dlr.status));
client.on('message', (msg) => console.log(`MO from ${msg.from}: ${msg.text}`));
client.on('error', (err) => console.error('SMPP error', err.code, err.message));

await client.connect();

try {
  const result = await client.sendText({
    to: '+2250700000000',
    from: 'MISSOU',
    text: 'Votre code est 123456 🎉',
    registeredDelivery: true,
  });
  console.log('sent', result); // { messageIds: ['...'], parts: 1, encoding: 'UCS2' }
} catch (err) {
  if (err instanceof SmppStatusError) {
    console.error(`refused by the SMSC: ${err.statusName} (${err.category})`);
  } else if (err instanceof SmppTimeoutError || err instanceof SmppConnectionClosedError) {
    // `written: false` → jamais parti, renvoi sans risque ; `true` → peut-être accepté, risque de doublon.
    console.error(`no answer (written: ${err.written})`);
  } else {
    throw err;
  }
}

process.on('SIGINT', async () => {
  await client.close({ drain: true });
  process.exit(0);
});
