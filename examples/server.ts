/**
 * Serveur : simulateur de SMSC qui accepte les submit_sm et renvoie un accusé de réception.
 *
 *   npx tsx examples/server.ts
 */
import { randomUUID } from 'node:crypto';
import { COMMAND_STATUS, SmppServer, safeCompare } from '../src/index.js';

const accounts = new Map([['acme', { password: 'secret', name: 'ACME' }]]);

const server = new SmppServer<{ name: string }>({
  // Même réponse (ESME_RBINDFAIL) que le compte existe ou non.
  authenticate: ({ system_id, password }) => {
    const account = accounts.get(system_id);
    const ok = safeCompare(password, account?.password ?? '');
    return account && ok ? { name: account.name } : false;
  },
  handlers: {
    submit_sm: async (pdu, session) => {
      if (!/^\d+$/.test(pdu.destination_addr)) return COMMAND_STATUS.ESME_RINVDSTADR;
      const messageId = randomUUID().replaceAll('-', '').slice(0, 16);
      if (pdu.registered_delivery & 0x01 && session.canDeliver) {
        setTimeout(() => {
          session
            .deliverReceipt({
              messageId,
              status: 'DELIVERED',
              source: pdu.destination_addr,
              destination: pdu.source_addr,
            })
            .catch(() => {});
        }, 500);
      }
      return { message_id: messageId };
    },
  },
  maxSessionsPerSystemId: 5,
  bindFailures: { maxAttempts: 5, banMs: 5 * 60_000 },
  logger: console,
});

server.on('bind', (s) => console.log(`bound: ${s.systemId} (${s.mode}) from ${s.remoteAddress}`));
server.on('bindFailed', (i) => console.warn(`bind failed for ${i.system_id} from ${i.remoteAddress}`));

const { port } = await server.listen(2775);
console.log(`SMPP server listening on ${port}`);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
