/**
 * Client: TLS connection, sending an SMS (split if needed), delivery receipts, graceful shutdown.
 *
 *   SMPP_URL=ssmpp://smsc.example.com:3550 SMPP_USER=xxx SMPP_PASSWORD=yyy npx tsx examples/client.ts
 */
import {
  SmppClient,
  SmppConnectionClosedError,
  SmppStatusError,
  SmppTimeoutError,
  SmppValidationError,
} from '../src/index.js';

const client = new SmppClient({
  url: process.env.SMPP_URL ?? 'smpp://127.0.0.1:2775',
  // SMSC with a self-signed certificate: provide its CA rather than disabling verification.
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
  // Groups the receipts of a long SMS's segments: one `messageStatus` event per message.
  trackDeliveries: true,
});

client.on('stateChange', (from, to) => console.log(`state: ${from} -> ${to}`));
client.on('reconnecting', (attempt, delay) => console.log(`reconnecting #${attempt} in ${delay} ms`));
client.on('deliveryReport', (dlr) => console.log('DLR', dlr.messageId, dlr.status));
client.on('messageStatus', (s) => console.log(`message ${s.reference}: ${s.outcome} (${s.parts} part(s))`));
client.on('message', (msg) => console.log(`MO from ${msg.from}: ${msg.text}`));
client.on('error', (err) => console.error('SMPP error', err.code, err.message));

await client.connect();

try {
  const result = await client.sendText({
    to: '+2250700000000',
    from: 'MISSOU',
    text: 'Your code is 123456 🎉',
    registeredDelivery: true,
    reference: 'otp-42', // your identifier, echoed in `messageStatus`
  });
  console.log('sent', result); // { messageIds: ['...'], parts: 1, encoding: 'UCS2' }
} catch (err) {
  if (err instanceof SmppValidationError) {
    // Nothing was sent: sender too long, invalid number…
    console.error(`invalid ${err.field}: ${err.message}`);
  } else if (err instanceof SmppStatusError) {
    console.error(`refused by the SMSC: ${err.statusName} (${err.category})`);
  } else if (err instanceof SmppTimeoutError || err instanceof SmppConnectionClosedError) {
    // `written: false` → never sent, safe to resend; `true` → may have been accepted, resending may duplicate it.
    console.error(`no answer (written: ${err.written})`);
  } else {
    throw err;
  }
}

process.on('SIGINT', async () => {
  await client.close({ drain: true });
  process.exit(0);
});
