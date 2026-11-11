# Mise en production

Ce guide sert à brancher `smpp-ts` sur le SMSC d'un opérateur ou d'un agrégateur. La plupart des incidents en production ne viennent pas du code mais d'un réglage qui ne correspond pas à ce que le SMSC attend. Chaque opérateur a ses règles. Posez-lui les questions ci-dessous **avant** d'écrire la configuration.

## 1. Questions à poser à l'opérateur

| Question | Option `smpp-ts` | Si on se trompe |
|---|---|---|
| Hôte, port, TLS ou non ? | `url: 'smpp://…'` ou `'ssmpp://…'` | Connexion refusée ou timeout |
| Certificat TLS signé par une autorité publique ? | `tls: { ca }` s'il est auto-signé | `connect()` échoue (vérification active par défaut) |
| `system_id`, `password`, `system_type` ? | `bind` | `ESME_RBINDFAIL` |
| Mode de bind : transmitter, receiver ou transceiver ? | `bind.mode` | Pas d'accusés reçus, ou `ESME_RINVBNDSTS` |
| Version SMPP : 3.4 ou 5.0 ? | `bind.interface_version` (défaut `0x34`) | Bind refusé par certains SMSC |
| Combien de sessions simultanées ? | Nombre de `SmppClient` | Binds en trop refusés (`ESME_RALYBND`) |
| Débit autorisé (SMS/s) par session ? | `rateLimit: { perSecond }` | `ESME_RTHROTTLED` en rafale |
| Fenêtre (requêtes sans réponse) autorisée ? | `window` (défaut 10) | `ESME_RTHROTTLED` ou coupure |
| Expéditeurs autorisés : alphanumériques ? numéros ? enregistrés à l'avance ? | `from`, `address` | Message rejeté ou expéditeur remplacé |
| TON/NPI attendus pour l'expéditeur et le destinataire ? | `sourceTon`, `destTon`… | `ESME_RINVSRCADR`, `ESME_RINVDSTADR` |
| Format des numéros : international sans `+`, national ? | `address.internationalPrefix` | `ESME_RINVDSTADR` |
| Encodage par défaut de `data_coding = 0` : GSM7, Latin-1 ? | `encodings` | Accents remplacés par `?` |
| Messages longs : UDH ou TLV SAR ? | `multipart.strategy` | Segments reçus séparément sur le téléphone |
| Format des `message_id` dans les accusés (hexadécimal, décimal) ? | `messageIdFormat` | Accusés impossibles à rapprocher |
| Intervalle d'`enquire_link` attendu ? | `enquireLinkInterval` (défaut 30 s) | Session coupée par le SMSC |
| Un SMSC de test est-il disponible ? | — | Vous testez en production |

## 2. Configuration type

```ts
import { readFileSync } from 'node:fs';
import { SmppClient, pinoAdapter } from 'smpp-ts';

const client = new SmppClient({
  url: process.env.SMPP_URL,                     // ssmpp://smsc.operateur.example:3550
  tls: process.env.SMPP_CA ? { ca: readFileSync(process.env.SMPP_CA) } : undefined,
  bind: {
    mode: 'transceiver',
    system_id: process.env.SMPP_SYSTEM_ID!,
    password: process.env.SMPP_PASSWORD!,
  },
  window: 10,
  rateLimit: { perSecond: 50 },                  // la valeur contractuelle, pas plus
  messageIdFormat: 'as-is',                      // 'hex-to-dec' si l'opérateur l'exige
  trackDeliveries: true,
  logger: pinoAdapter(logger),
  redactContent: true,                           // contenu des SMS = données personnelles
  redactNumbers: true,
});
```

Les identifiants viennent de l'environnement ou d'un coffre-fort, jamais du code. Le mot de passe n'apparaît jamais dans les logs de `smpp-ts`.

## 3. Expéditeur (`from`)

- **Alphanumérique** (`MONSERVICE`) : 11 caractères au plus, alphabet GSM. `smpp-ts` refuse au-delà, car les réseaux tronquent ou rejettent sans erreur claire. Dans beaucoup de pays, l'expéditeur doit être enregistré à l'avance auprès de l'opérateur, sinon il est remplacé par un numéro ou le message est bloqué.
- **Numéro** : passez-le au format international (`+225…`). Le `+` est retiré et le TON passe à 1, comme l'attendent la plupart des SMSC.
- **Code court** (`1234`) : envoyé tel quel avec TON 0. Certains opérateurs veulent TON 3 (spécifique au réseau) : `sourceTon: 3`.
- Le préfixe `+` n'a de sens que pour un numéro. Ne l'ajoutez jamais à un expéditeur alphanumérique.

## 4. Accusés de réception

1. Demandez-les à l'envoi : `registeredDelivery: true`.
2. Bindez en `transceiver` (ou ouvrez une session `receiver` en plus), sinon le SMSC n'a aucune session où les livrer.
3. **Enregistrez chaque `messageId`** renvoyé par `sendText` avec votre propre identifiant de message, puis rapprochez les événements `deliveryReport` par `messageId`. Pour un SMS long, `sendText` renvoie un `messageId` par segment.
4. Avec `trackDeliveries: true` et `reference`, l'événement `messageStatus` donne directement l'issue du message entier.
5. Si les accusés n'arrivent jamais à rapprocher, comparez `dlr.rawMessageId` et `result.messageIds` : un écart hexadécimal/décimal se corrige avec `messageIdFormat`.
6. Les accusés arrivent parfois des heures plus tard (téléphone éteint). Persistez l'état côté application. Le suivi intégré est en mémoire et se perd au redémarrage.

`smpp-ts` répond automatiquement `deliver_sm_resp` à chaque accusé et message entrant. Avec `autoAck: false`, répondez vous-même avec `client.respond(pdu)`, sinon le SMSC renverra les mêmes accusés en boucle.

## 5. Erreurs et renvois

| Erreur | Signification | Action |
|---|---|---|
| `SmppValidationError` | Rien n'est parti (adresse, texte, paramètre invalide) | Corriger la donnée, ne pas réessayer tel quel |
| `SmppStatusError`, `category: 'temporary'` | Déjà réessayé `retry.maxRetries` fois | Remettre en file plus tard |
| `SmppStatusError`, `category: 'permanent'` | Refus définitif (`ESME_RINVDSTADR`…) | Marquer en échec |
| `SmppConnectionClosedError`, `written: false` | Jamais écrit sur le socket | Renvoyer sans risque |
| `SmppConnectionClosedError` ou `SmppTimeoutError`, `written: true` | Le SMSC l'a peut-être accepté | Attendre l'accusé, ou vérifier avec `query()`, avant de renvoyer |
| `SmppQueueFullError` | La file locale est pleine (SMSC lent ou coupé) | Ralentir l'application |
| `SmppMultipartError` | Une partie des segments seulement est partie | `results` donne le détail par segment |

La lib ne renvoie jamais d'elle-même un message qui a pu être accepté, pour éviter les doublons facturés.

## 6. Arrêt propre

```ts
process.on('SIGTERM', async () => {
  await client.close({ drain: true, timeout: 15_000 });
  process.exit(0);
});
```

`drain` attend la fin des envois en cours, envoie `unbind` puis ferme. Un arrêt brutal laisse des messages dans l'état « peut-être accepté ».

## 7. Surveillance

À suivre au minimum, via `client.on('metric')` ou `smpp-ts/otel` :

- `request.latency` : une hausse annonce souvent un `ESME_RTHROTTLED`.
- `command_status` par code : un pic de `ESME_RTHROTTLED` veut dire que `rateLimit` est trop haut ; un pic de `ESME_RINVDSTADR` signale un problème de format de numéro.
- `queue.size` : une file qui grossit veut dire que le SMSC n'absorbe pas le débit.
- `session.reconnect` : des reconnexions fréquentes viennent souvent d'un `enquireLinkInterval` plus long que le délai d'inactivité du SMSC, ou d'un pare-feu qui coupe les connexions inactives.
- Événement `messageStatus` : le taux de `DELIVERED` par opérateur est l'indicateur métier.

## 8. Avant d'ouvrir le trafic

1. Lancez la suite d'interopérabilité contre le SMSC de test de l'opérateur (cf. [test/interop/README.md](../test/interop/README.md)).
2. Envoyez à la main, vers un téléphone de test : un SMS GSM7, un SMS avec accents, un SMS avec emoji, un SMS de plus de 160 caractères. Vérifiez que le long message s'affiche **en un seul** message sur le téléphone.
3. Vérifiez que les accusés arrivent et se rapprochent de leurs `messageId`.
4. Coupez le réseau quelques minutes pendant un envoi en rafale : la session doit se reconnecter et les messages en file partir après le re-bind.
5. Relisez les logs : aucun mot de passe, et pas de contenu de SMS si `redactContent` est activé.
