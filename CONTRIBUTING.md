# Contribuer

## Mise en place

```sh
npm install
npm test
```

Node ≥ 20 est requis.

## Avant d'ouvrir une PR

```sh
npm run typecheck
npm run lint
npm test
npm run coverage   # ≥ 90 % des lignes sur codec/, encoding/ et session/
```

Pour une modification du parseur, lancez aussi `npm run fuzz` (1 000 000 d'itérations).

Ajoutez un changeset qui décrit la modification pour les utilisateurs :

```sh
npx changeset
```

## Règles

- **Architecture en couches** : une couche ne dépend que des couches inférieures (`protocol` → `codec`/`encoding` → `transport` → `session` → `client`/`server`). `codec` et `encoding` n'importent jamais `net`, `tls` ni `events`.
- **Source de vérité** : les commandes et les TLV sont décrits dans `src/protocol/`. Les types et le codec en dérivent : on ajoute une commande ou un TLV dans la table, pas dans le codec.
- **Nommage** : les champs PDU gardent le snake_case de la spec SMPP (`destination_addr`), l'API utilise le camelCase (`sendText`, `requestTimeout`).
- **Sûr par défaut** : une option de sécurité se désactive explicitement, elle ne s'active jamais.
- **Erreurs** : toujours une sous-classe de `SmppError`. Les valeurs sensibles (mot de passe) ne figurent jamais dans un message d'erreur.
- **Zéro dépendance runtime.**
- **Tests** : chaque bug corrigé reçoit un test de non-régression.
