# Guide de migration

Ce guide aide à passer d'une bibliothèque SMPP Node.js à callbacks (une seule classe `Session`, envoi par `session.submit_sm(params, callback)`) à `smpp-ts`.

## Connexion et bind

Avant :

```js
const session = smpp.connect({ url: 'smpp://smsc:2775', auto_enquire_link_period: 30000 }, () => {
  session.bind_transceiver({ system_id: 'xxx', password: 'yyy' }, (pdu) => {
    if (pdu.command_status !== 0) { /* … */ }
  });
});
```

Après :

```ts
const client = new SmppClient({
  url: 'smpp://smsc:2775',
  bind: { mode: 'transceiver', system_id: 'xxx', password: 'yyy' },
  enquireLinkInterval: 30_000,
});
await client.connect(); // rejette avec SmppStatusError si le bind est refusé
```

Le keepalive est actif par défaut et une connexion morte est détectée (`enquireLinkTimeout`). La reconnexion avec re-bind est automatique.

## Envoi

Avant : trois callbacks (réponse, envoi, échec), et aucune notification si le SMSC ne répond jamais.

```js
session.submit_sm({ destination_addr: '…', short_message: 'Hello' }, (pdu) => {
  if (pdu.command_status === 0) console.log(pdu.message_id);
});
```

Après : une Promise qui aboutit toujours, par une réponse, une erreur ou un timeout.

```ts
const { message_id } = await client.submit({ destination_addr: '…', short_message: 'Hello' });
// ou, avec choix de l'encodage et découpage automatiques :
const { messageIds } = await client.sendText({ to: '…', from: '…', text: 'Hello' });
```

Les raccourcis par commande restent disponibles sous `client.raw` : `client.raw.submit_multi({ … })`, `client.raw.data_sm({ … })`…

## Différences de comportement

| Sujet | Avant | `smpp-ts` |
|---|---|---|
| TLS | Certificat non vérifié par défaut | **Vérifié** ; utiliser `tls.ca` pour un certificat auto-signé |
| SMSC muet | Attente infinie | `SmppTimeoutError` après `requestTimeout` |
| Coupure réseau | Callbacks perdus | `SmppConnectionClosedError` avec `written` |
| Événement `error` non écouté | Arrêt du processus | Transmis au logger |
| PDU invalide reçu | Arrêt du traitement | `generic_nack` et la session continue |
| Logs debug | PDU complets, mot de passe compris | Mot de passe toujours masqué |
| Envoi avant bind | Possible | `SmppStateError` |
| `short_message` texte | Remplacement silencieux des caractères non représentables | Erreur si un encodage forcé ne peut pas représenter le texte |

## Réception

```ts
client.on('deliver', (pdu) => { /* PDU brut */ });
client.on('deliveryReport', (dlr) => { /* { messageId, status: 'DELIVERED' | … } */ });
client.on('message', (msg) => { /* MO, segments déjà réassemblés */ });
```

Le `deliver_sm_resp` est envoyé automatiquement. Avec `autoAck: false`, répondez vous-même avec `client.respond(pdu, { command_status })`.

## Serveur

Avant : les événements `session` et `bind_transceiver`, puis `session.send(pdu.response())`.

Après :

```ts
new SmppServer({
  authenticate: ({ system_id, password }) => …,  // obligatoire
  handlers: { submit_sm: (pdu) => ({ message_id: '…' }) },
});
```

## Proxy Protocol

Plus de dépendance externe ni de remplacement de `socket.emit`. Les versions v1 et v2 sont gérées en interne, et la liste des proxys de confiance est obligatoire :

```ts
new SmppServer({ …, proxyProtocol: { trustedProxies: ['10.0.0.0/8'] } });
```
