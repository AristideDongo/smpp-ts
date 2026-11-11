# smpp-ts

## 0.2.0

### Minor Changes

- 7438d09: `sendText` normalise et valide les adresses : retrait des séparateurs (`+225 07 00…`), préfixe `00` converti en TON international, expéditeur alphanumérique limité à 11 caractères GSM, numéro international limité à 15 chiffres. Option `address` pour ajuster ou désactiver. Les erreurs sont levées avant tout envoi (`SmppValidationError`).
- 7438d09: Suivi des accusés multi-segments : option `trackDeliveries` et événement `messageStatus` (`DELIVERED`, `FAILED`, `PARTIALLY_DELIVERED`, `TIMEOUT`), avec `reference` applicative. Classe `DeliveryTracker` exportée pour un usage autonome. Mémoire bornée (`maxTracked`, `ttl`).
- 7438d09: Adaptateur OpenTelemetry `smpp-ts/otel` : `instrumentSmpp(clientOuServeur, meter)` relaie les métriques vers un `Meter` OpenTelemetry (compteurs, histogramme de latence, jauges, attribut `smpp.system_id` côté serveur). Aucune dépendance : le `Meter` est fourni par l'application.

### Patch Changes

- 7438d09: Compatibilité Bun et Deno vérifiée en CI par un test de fumée sur le paquet compilé (`test/runtime/smoke.mjs`). Nouvelle suite d'interopérabilité `npm run test:interop`, exécutable contre un SMSC simulé (Docker) ou le SMSC de test d'un opérateur.

## 0.1.0

Première version publique.

- Client (`SmppClient`) et serveur (`SmppServer`) SMPP v3.4 / v5.0.
- Codec typé dérivé d'une table déclarative des commandes, TLV et codes de statut ; TLV personnalisés.
- Encodages GSM7 (tables de shift turque, espagnole, portugaise), Latin-1, UCS2 ; détection automatique.
- Messages longs (`udh8`, `udh16`, `sar`, `payload`) et réassemblage borné des messages entrants.
- Accusés de réception : parseur tolérant, priorité aux TLV, normalisation des statuts et des `message_id`.
- Fiabilité : machine à états, timeouts sur chaque opération, fenêtre d'envoi, file bornée, contrôle de débit adaptatif, keepalive avec détection de connexion morte, reconnexion avec re-bind, nouvelles tentatives sur erreurs temporaires, arrêt gracieux.
- Sécurité : TLS vérifié par défaut (TLS 1.2 minimum), secrets jamais journalisés, validation stricte, authentification serveur obligatoire, limites de ressources, Proxy Protocol v1/v2 avec proxys de confiance.
- Aucune dépendance runtime.
