# smpp-ts

[![npm](https://img.shields.io/npm/v/smpp-ts.svg)](https://www.npmjs.com/package/smpp-ts)
[![CI](https://github.com/AristideDongo/smpp-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/AristideDongo/smpp-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Client et serveur **SMPP v3.4 / v5.0** en TypeScript : sûr par défaut, fiable en production, sans aucune dépendance runtime.

- **Sûr par défaut** : TLS vérifié (TLS 1.2 minimum), mots de passe jamais journalisés, chaque champ est validé avant l'envoi et à la réception.
- **Aucun message perdu en silence** : chaque requête aboutit à une réponse, une erreur typée ou un timeout. Jamais d'attente infinie.
- **Le parseur ne plante jamais** : testé par fuzzing sur 1 million d'entrées aléatoires ou corrompues.
- **Fonctions intégrées** : reconnexion avec re-bind, fenêtre d'envoi, contrôle de débit, découpage des SMS longs, réassemblage, accusés de réception, Proxy Protocol.
- **Fidèle à la spécification** : les champs des PDU portent leur nom SMPP (`destination_addr`, `data_coding`…) et sont typés commande par commande.

Node ≥ 20 · ESM + CJS · déclarations `.d.ts` incluses.

```sh
npm install smpp-ts
```

## Client

```ts
import { SmppClient } from 'smpp-ts';

const client = new SmppClient({
  url: 'ssmpp://smsc.example.com:3550',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  window: 10,
  rateLimit: { perSecond: 50 },
  reconnect: { initialDelay: 1_000, maxDelay: 30_000 },
  requestTimeout: 10_000,
});

await client.connect();

const result = await client.sendText({
  to: '+2250700000000',
  from: 'MISSOU',
  text: 'Votre code est 123456 🎉',
  registeredDelivery: true,
});
// { messageIds: ['...'], parts: 1, encoding: 'UCS2' }

client.on('deliveryReport', (dlr) => console.log(dlr.messageId, dlr.status));
client.on('message', (msg) => console.log(`MO de ${msg.from} : ${msg.text}`));

await client.close({ drain: true });
```

### Envoi

| Méthode | Rôle |
|---|---|
| `sendText({ to, from, text, … })` | Choisit l'encodage, découpe le texte et renvoie tous les `message_id` |
| `submit(params)` | `submit_sm` bas niveau |
| `query(id)`, `cancel(id)`, `replace(id, params)` | `query_sm`, `cancel_sm`, `replace_sm` |
| `request(command, params)` | N'importe quelle commande SMPP |
| `raw.submit_multi(params)`, `raw.data_sm(params)`… | Raccourcis typés par commande |

`sendText` déduit le TON/NPI de chaque adresse :

| Adresse | TON | NPI |
|---|---|---|
| alphanumérique (`MISSOU`) | 5 (alphanumérique) | 0 |
| `+2250700000000` (le `+` est retiré) | 1 (international) | 1 (E.164) |
| `0700000000` | 0 (inconnu) | 1 |

Les options `sourceTon`, `sourceNpi`, `destTon` et `destNpi` remplacent ces valeurs.

### Erreurs

Toutes les erreurs héritent de `SmppError` et portent un `code` stable :

| Classe | Cas |
|---|---|
| `SmppStatusError` | Réponse avec `command_status ≠ 0` : `status`, `statusName`, `category` (`temporary`, `permanent`, `session`) |
| `SmppTimeoutError` | Délai dépassé (requête, bind, keepalive…) : `kind`, `written` |
| `SmppConnectionClosedError` | Connexion fermée avec une requête en attente : `written` |
| `SmppQueueFullError` | File d'envoi pleine |
| `SmppStateError` | Opération interdite dans l'état ou le mode de bind courant |
| `SmppValidationError` | Paramètre invalide : aucun PDU n'a été envoyé |
| `SmppDecodeError` | PDU reçu invalide |
| `SmppMultipartError` | Échec partiel d'un envoi en plusieurs segments : `results` |

`written` indique si le PDU a été écrit sur le socket. Avec `written: false`, le message n'est jamais parti et on peut le renvoyer sans risque. Avec `written: true`, le SMSC l'a peut-être accepté, et un renvoi peut créer un doublon. La lib ne renvoie jamais d'elle-même un message qui a pu être accepté : c'est l'application qui décide.

Un événement `error` sans écouteur ne termine pas le processus : il est transmis au logger.

### Fiabilité

| Option | Défaut | Effet |
|---|---|---|
| `connectTimeout` | 10 s | Rejet de `connect()` |
| `bindTimeout` | 10 s | Rejet du bind |
| `requestTimeout` | 10 s | Rejet de la requête (temps en file compris) |
| `enquireLinkInterval` | 30 s | Envoi d'un `enquire_link` après cette durée sans trafic |
| `enquireLinkTimeout` | 10 s | Pas de réponse : la session est déclarée morte, puis reconnexion |
| `unbindTimeout` | 5 s | Fermeture forcée du socket |
| `window` | 10 | Requêtes en vol simultanées |
| `maxQueueSize` | 10 000 | Au-delà : `SmppQueueFullError` |
| `reconnect` | activée | Backoff exponentiel avec gigue, tentatives illimitées |
| `retry` | 2 nouvelles tentatives | Uniquement sur statut temporaire (`ESME_RTHROTTLED`, `ESME_RMSGQFUL`, `ESME_RSYSERR`) |
| `rateLimit` | aucun | Seau à jetons ; le débit baisse automatiquement sur `ESME_RTHROTTLED` / `ESME_RMSGQFUL` |

Pendant une reconnexion, les messages qui n'ont pas encore été écrits restent en file et partent après le re-bind. Les messages en vol au moment de la coupure sont rejetés avec `SmppConnectionClosedError` (`written: true`).

`close({ drain: true })` refuse les nouveaux envois, attend la fin des requêtes en cours, envoie `unbind`, puis ferme la connexion.

### TLS

La vérification du certificat est **activée par défaut**. Si le SMSC utilise un certificat auto-signé, fournissez son autorité de certification plutôt que de désactiver la vérification :

```ts
new SmppClient({
  url: 'ssmpp://smsc.example.com:3550',
  tls: { ca: readFileSync('smsc-ca.pem') },
  bind: { … },
});
```

`rejectUnauthorized: false` reste possible, mais chaque connexion produit alors un avertissement dans les logs.

### Messages longs

| `multipart.strategy` | Mécanisme |
|---|---|
| `udh8` (défaut) | UDH de concaténation 8 bits (IEI 0x00) |
| `udh16` | UDH de concaténation 16 bits (IEI 0x08) |
| `sar` | TLV `sar_msg_ref_num`, `sar_total_segments`, `sar_segment_seqnum` |
| `payload` | Un seul PDU avec `message_payload` |

Le découpage ne coupe jamais une séquence d'échappement GSM ni un emoji (paire de substitution UTF-16). À la réception, les segments sont réassemblés par (source, destination, référence), avec une durée de vie (`reassembly.ttl`, 5 min) et un nombre maximal de messages incomplets en mémoire (`reassembly.maxBuffers`, 1 000). À l'expiration, l'événement `partialMessage` livre ce qui a été reçu.

## Serveur

```ts
import { SmppServer, safeCompare, COMMAND_STATUS } from 'smpp-ts';

const server = new SmppServer({
  authenticate: async ({ system_id, password, remoteAddress, mode }) => {
    const account = await db.findAccount(system_id);
    return account && safeCompare(password, account.password) ? { accountId: account.id } : false;
  },
  handlers: {
    submit_sm: async (pdu, session) => {
      const id = await queue.push(pdu);
      return { message_id: id };          // ou un code : return COMMAND_STATUS.ESME_RINVDSTADR
    },
  },
  tls: { key, cert },                     // optionnel
});

await server.listen(2775);
await server.deliver('system_id', { source_addr: '…', destination_addr: '…', short_message: Buffer.from('…') });
```

- `authenticate` est obligatoire. Un refus renvoie toujours `ESME_RBINDFAIL`, que le compte existe ou non, ce qui empêche d'énumérer les comptes.
- Tant qu'une session n'est pas bindée, elle ne traite que `bind_*`, `enquire_link`, `unbind` et `generic_nack`. Toute autre commande reçoit `ESME_RINVBNDSTS`.
- Une session `transmitter` ne reçoit pas de `deliver_sm`, et une session `receiver` ne peut pas envoyer de `submit_sm`.
- Si un handler échoue ou ne répond pas dans `handlerTimeout` (10 s), le serveur répond `ESME_RSYSERR`.
- Limites intégrées : `bindTimeout` (30 s), `idleTimeout` (5 min), `maxSessions`, `maxSessionsPerIp`, `maxSessionsPerSystemId`, et bannissement temporaire d'une IP après des binds échoués répétés (`bindFailures`).
- Proxy Protocol v1 et v2, désactivé par défaut : `proxyProtocol: { trustedProxies: ['10.0.0.0/8'] }`. Un en-tête PROXY qui vient d'une adresse non listée est rejeté.

## Utilitaires

```ts
import { countSegments, detectEncoding, parseDlr, formatRelativeTime, parseSmppTime } from 'smpp-ts';

countSegments('Bonjour {monde} €');
// { encoding: 'gsm7', segments: 1, units: 20, perSegment: 160, remaining: 140, … }

detectEncoding('Şişli', { shiftTables: ['tr'] });   // { encoding: 'gsm7', shift: 'tr' }
parseDlr('id:123 sub:001 dlvrd:001 … stat:DELIVRD err:000 text:…');
formatRelativeTime(2 * 3600_000);                    // '000000020000000R'
```

| Encodage | `data_coding` | Seul | Avec UDH 8 bits |
|---|---|---|---|
| GSM7 | 0x00 | 160 caractères | 153 caractères |
| Latin-1 | 0x03 | 140 caractères | 134 caractères |
| UCS2 | 0x08 | 70 unités | 67 unités |

Les caractères de la table d'extension GSM (`€ [ ] { } \ ^ ~ |`) comptent pour 2. La détection automatique utilise Latin-1 et les tables de shift nationales (turque, espagnole, portugaise) seulement si vous les autorisez, car beaucoup d'opérateurs ne les prennent pas en charge. Avec un encodage forcé, un texte non représentable lève une erreur au lieu d'être remplacé en silence par `?`. Le registre `encodings` accepte des encodages propres à un opérateur.

## Logs et métriques

```ts
new SmppClient({ …, logger: console });        // ou pinoAdapter(pino())
new SmppClient({ …, redactContent: true, redactNumbers: true });
client.on('metric', (m) => prometheus.observe(m));
```

- Le logger est silencieux par défaut. Les mots de passe sont toujours masqués, et le contenu des SMS et les numéros le sont sur option.
- Chaque ligne de log porte `sessionId`, `systemId`, `remoteAddress`, `command` et `sequence_number`.
- Métriques émises : `pdu.sent`, `pdu.received`, `request.latency`, `request.timeout`, `request.inflight`, `queue.size`, `session.reconnect`, `command_status`, `bytes.in` et `bytes.out`.

## Bas niveau

```ts
import { encodePdu, decodePdu, PduCodec, Framer } from 'smpp-ts';

const buf = encodePdu({ command: 'submit_sm', destination_addr: '225…', short_message: Buffer.from('Hi') });
const pdu = decodePdu(buf);
if (pdu.command === 'submit_sm') pdu.short_message; // typé

// TLV propres à un opérateur
const codec = new PduCodec({ customTlvs: [{ name: 'operator_ref', tag: 0x1501, type: 'cstring', max: 32 }] });
```

## Développement

```sh
npm test           # unitaires, propriétés, fuzzing (20 000 itérations), intégration
npm run fuzz       # fuzzing du parseur, 1 000 000 d'itérations
npm run coverage
npm run typecheck && npm run lint && npm run build
```

Voir [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) et [MIGRATION.md](MIGRATION.md).

## Licence

MIT
# smpp-ts
